// 클럽 정보 > 주차 내역 > 활동 관리(상세 페이지 A) — 조회/오픈확인/검수 (read + light-write).
//
// 라우트와 검증 스크립트가 동일 함수를 호출해 "direct == HTTP" 를 보장한다.
//
// 이번 범위: 상단(현재/관리 주차) + 허브/라인 오픈 설정(체크 상태)까지.
//   [액트 체크 관리]·[라인 개설 관리] 실제 처리는 미구현.
//
// 데이터 원천(전부 live 조회 — 고객 weekly-card snapshot 무접촉):
//   · 주차 메타/공식휴식/현재주차 = loadSeasonWeeks (3-tier 공식휴식 판정 포함)
//   · 주차 검수(reviewed)         = weeks.result_reviewed_at != null (주차 전역·org 무관)
//   · 오픈 설정/오픈확인          = cluster4_week_opening_configs (주차×클럽). 없으면 정책 기본값.
//   · 실무 정보 라인              = activity_types(cluster_id='practical_info', 활성)
//   · 실무 경험 팀                = listTeams(org, mode) (cluster4_teams, (T) 스코프)
//   · 확장 주차 판정              = cluster4_experience_extension_periods 기간 겹침(미적용 시 false)
//
// 기본 체크 정책:
//   · 실무 정보  : 전부 unchecked
//   · 실무 경험  : 도출·분석·견문·관리 checked, 확장 = isExpansionWeek
//   · 실무 역량  : 항상 checked
//   · 실무 경력  : 데이터 없음(DTO 미포함)
//   저장된 config 가 있으면 해당 값으로 덮어쓴다(없는 키는 기본값 유지).
//
// mode(operating/test): 실무 경험 팀 목록만 스코프(운영 팀 vs (T) 팀)가 달라진다. DTO 구조는 동일.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  loadSeasonWeeks,
  type SeasonWeekDto,
} from "@/lib/adminSeasonWeeksData";
import {
  weekTableName,
  weekBannerName,
  weekRangeLabel,
  formatTodayLabel,
} from "@/lib/adminTeamPartsInfoWeeksData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { listTeams } from "@/lib/adminExperienceLineData";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  markWeekResultPublished,
  markWeekResultReviewed,
  recomputeCohortSnapshots,
  WeekResultPublishError,
  WeekResultReviewError,
} from "@/lib/adminWeekRecognitionsData";
import { revertWeeklyCardFinalization } from "@/lib/adminWeeklyCardFinalizationData";
import type { StateScope } from "@/lib/operationalState";
import {
  finalizeWeekUws,
  revertWeekUws,
  UwsFinalizeBlockedError,
  type FinalizeUwsResult,
} from "@/lib/adminWeekUwsFinalize";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recalcUserGrowthStatsForUsers } from "@/lib/userGrowthStatsData";
import {
  prepareWeekRecognition,
  recognitionUpsertFields,
  formatMissingPointConfigMessage,
  clearWeekRecognition,
  loadWeekRecognitionCount,
} from "@/lib/weekRecognitionResolve";

// 검수 완료/실행 취소의 사후 재계산(고객 snapshot·성장 캐시) 동시성 상한.
//   snapshot 1건 ≈ 5s(실측 2026-07-09) 라 코호트가 크면 concurrency 가 벽시계를 좌우한다.
//   lib DB 포화 가드 상한(8)과 동일 — 그 이상은 statement timeout/커넥션 포화 위험.
const REVIEW_RECOMPUTE_CONCURRENCY = 8;

export type WeekActivityStatus = "official_activity" | "official_rest";
export type ExperienceLineType =
  | "derive"
  | "analysis"
  | "research"
  | "management"
  | "expansion";

// 실무 경험 5종 라인 타입(표시 순서 = 도출·분석·견문·관리·확장).
export const EXPERIENCE_LINE_TYPES: ExperienceLineType[] = [
  "derive",
  "analysis",
  "research",
  "management",
  "expansion",
];

// ── 라인 개설(8) 선택 — 실제 라인 목록 ──────────────────────────────────────
//   정보 = activity_types 키(개설 판정 회로 불변) + line_registrations(info) 명칭/순서 미러링.
export type OpeningInfoLine = { lineId: string; lineName: string; checked: boolean };
export type OpeningExperienceLine = { type: ExperienceLineType; checked: boolean };
export type OpeningExperienceTeam = {
  teamId: string;
  teamName: string;
  lines: OpeningExperienceLine[];
};
export type OpeningCompetency = { checked: boolean };

// ── 액트 체크(7) 선택 — 라인급(체크) = process_line_groups 단일 SoT ──────────
//   프로세스 등록(소속 라인급)·활동관리 라인급(체크)·액트 체크 분류가 모두 이 line_group_id 를 공유.
export type ActCheckLineGroup = { lineGroupId: string; name: string; checked: boolean };
export type ActCheckExperienceTeam = {
  teamId: string;
  teamName: string;
  lineGroups: ActCheckLineGroup[];
};

export type TeamPartsInfoWeekDetailData = {
  currentWeek: {
    todayLabel: string;
    seasonWeekName: string | null;
    weekRangeLabel: string | null;
    activityStatus: WeekActivityStatus | null;
  };
  managedWeek: {
    weekId: string;
    weekName: string;
    // 사람이 읽는 주차 표시명("26년 여름 시즌 8주차") — 전역 헤더 경로 표시용(내부 코드 미노출).
    //   표 표기(weekName=weekTableName "26 - 여름 - 8")와 별개로 배너 포맷 SoT(weekBannerName) 재사용.
    weekBannerName: string;
    weekRangeLabel: string;
    activityStatus: WeekActivityStatus;
    reviewed: boolean;
    // [오픈 확인] 저장 여부(주차×클럽). GET 시 V 표시 복원용.
    openConfirmed: boolean;
    // 주차 진행 단계(과거/현재/미래) — 프로젝트 공통 주차 판정 재사용(loadSeasonWeeks 의 is_current_week +
    //   동일 today/날짜 비교). 과거 주차 오픈 상태 변경 시 확인 모달을 띄우는 UI 게이트용(로직 무영향·표시 힌트).
    weekPhase: "past" | "current" | "future";
    // 확장 주차 여부 — [초기화] 시 실무 경험 라인(개설) 확장 기본값 복원용(도출/분석/견문/관리=true·확장=isExpansionWeek).
    isExpansionWeek: boolean;
    // 주차별 활동 인정 개수 N(오픈확인 시점 확정 저장값). 인정 컬럼 미적용/미계산이면 null →
    //   프론트가 Phase1 기본값(DEFAULT_WEEK_RECOGNITION_COUNT)으로 폴백.
    weekRecognitionCount: number | null;
  };
  openingConfig: {
    // (1)(3)(6) 라인급(체크) — process_line_groups 기반. (7) 액트 체크 관리에만 반영.
    actCheck: {
      info: ActCheckLineGroup[];
      experience: ActCheckExperienceTeam[];
      club: ActCheckLineGroup[];
      // competency 는 practicalCompetency.checked 를 공유(별도 라인급 체크 없음).
    };
    // (2)(4) 라인(개설) — 실제 라인 목록. (8) 라인 개설 관리에만 반영.
    lineOpening: {
      practicalInfo: OpeningInfoLine[];
      practicalExperience: OpeningExperienceTeam[];
    };
    // (5) 실무 역량 정상 진행 — (7)(8) 양쪽에 반영(공유).
    practicalCompetency: OpeningCompetency;
  };
};

// 실무 정보 활동유형 표시 순서(adminCluster4InfoLineResults PREFERRED_ORDER 미러).
const INFO_PREFERRED_ORDER = [
  "wisdom",
  "essay",
  "infodesk",
  "calendar",
  "forum",
  "session",
  "practical_lecture",
  "community",
  "etc_a",
];

export class WeekDetailNotFoundError extends Error {
  constructor(message = "주차를 찾을 수 없습니다.") {
    super(message);
    this.name = "WeekDetailNotFoundError";
  }
}

function activityStatusOf(r: SeasonWeekDto): WeekActivityStatus {
  return r.is_official_rest ? "official_rest" : "official_activity";
}

// 저장된 오픈 설정(config jsonb) + open_confirmed. 테이블 미적용/행 없음 → null(정책 기본값).
//   practicalInfo/practicalExperience = 라인 개설(8) 선택(기존 키 그대로 — 하위호환·통계 불변).
//   practicalCompetency = (5) 공유. actCheck = 액트 체크(7) 선택(신설, process_line_groups id 기반).
export type SavedConfig = {
  practicalInfo?: Record<string, boolean>;
  practicalExperience?: Record<string, Partial<Record<ExperienceLineType, boolean>>>;
  practicalCompetency?: { checked?: boolean };
  actCheck?: {
    info?: Record<string, boolean>;
    experience?: Record<string, Record<string, boolean>>;
    club?: Record<string, boolean>;
  };
};
// 액트 체크 관리 등 다른 조회에서도 오픈 설정을 읽을 수 있게 export.
export async function loadWeekOpeningConfig(
  weekId: string,
  organization: OrganizationSlug,
): Promise<{ config: SavedConfig | null; openConfirmed: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("config,open_confirmed")
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .maybeSingle();
  if (error) {
    console.warn("[team-parts/info/weeks/detail] opening config read unavailable:", error.message);
    return { config: null, openConfirmed: false };
  }
  const row = data as { config: SavedConfig | null; open_confirmed: boolean } | null;
  return { config: row?.config ?? null, openConfirmed: row?.open_confirmed === true };
}

// weeks.result_reviewed_at != null. 컬럼 미적용 시 false.
async function loadReviewed(weekId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("result_reviewed_at")
    .eq("id", weekId)
    .maybeSingle();
  if (error) {
    console.warn("[team-parts/info/weeks/detail] result_reviewed_at read unavailable:", error.message);
    return false;
  }
  return (data as { result_reviewed_at: string | null } | null)?.result_reviewed_at != null;
}

// 확장 주차 = 활성 experience 확장기간(org-특정 ∨ 공통) 중 관리 주차 기간과 겹치는 것이 있는가.
//   원천: cluster4_experience_extension_periods. 미적용/오류 → false(fail-closed, expansion/opening-status 미러).
async function loadIsExpansionWeek(
  organization: OrganizationSlug,
  weekStart: string | null,
  weekEnd: string | null,
): Promise<boolean> {
  if (!weekStart || !weekEnd) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from("cluster4_experience_extension_periods")
      .select("start_date,end_date,organization_slug")
      .eq("is_active", true)
      .or(`organization_slug.is.null,organization_slug.eq.${organization}`);
    if (error) return false;
    return ((data ?? []) as Array<{ start_date: string | null; end_date: string | null }>).some(
      (p) => p.start_date != null && p.end_date != null && p.start_date <= weekEnd && p.end_date >= weekStart,
    );
  } catch {
    return false;
  }
}

// 실무 정보 라인 개설(8) 카탈로그 — 키=activity_type id(개설 판정 회로 cluster4_lines.activity_type_id
//   와 조인·불변), 표시명/순서=line_registrations(hub='info') 미러링(실제 등록 라인 명칭). 동일 9종을
//   순서(activity_type INFO_PREFERRED_ORDER ↔ line_registrations line_code)로 위치 매칭한다.
async function loadInfoLineCatalog(): Promise<Array<{ lineId: string; lineName: string }>> {
  const [{ data: atData, error: atErr }, { data: lrData }] = await Promise.all([
    supabaseAdmin.from("activity_types").select("id,name").eq("cluster_id", "practical_info").eq("is_active", true),
    supabaseAdmin.from("line_registrations").select("line_name,line_code").eq("hub", "info").eq("is_active", true),
  ]);
  if (atErr) {
    console.warn("[team-parts/info/weeks/detail] activity_types read unavailable:", atErr.message);
    return [];
  }
  const orderIdx = (id: string) => {
    const i = INFO_PREFERRED_ORDER.indexOf(id);
    return i < 0 ? INFO_PREFERRED_ORDER.length : i;
  };
  const ats = ((atData ?? []) as Array<{ id: string; name: string | null }>)
    .sort((a, b) => orderIdx(a.id) - orderIdx(b.id) || a.id.localeCompare(b.id));
  // line_registrations(info) 를 line_code 순으로 — activity_type 순서와 위치 대응(둘 다 동일 9종).
  const regs = ((lrData ?? []) as Array<{ line_name: string | null; line_code: string | null }>)
    .sort((a, b) => (a.line_code ?? "").localeCompare(b.line_code ?? ""));
  return ats.map((a, i) => ({ lineId: a.id, lineName: regs[i]?.line_name ?? a.name ?? a.id }));
}

// 라인급(체크) SoT — process_line_groups(hub, is_active). 프로세스 등록 소속 라인급과 동일 목록.
//   sort_order → created_at 순(register 목록과 동일 정렬). 미적용/오류 시 빈 배열(구조 유지).
export async function loadProcessLineGroups(
  hub: "info" | "experience" | "competency" | "club",
): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await supabaseAdmin
    .from("process_line_groups")
    .select("id,name,sort_order,created_at")
    .eq("hub", hub)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.warn(`[team-parts/info/weeks/detail] process_line_groups(${hub}) read unavailable:`, error.message);
    return [];
  }
  return ((data ?? []) as Array<{ id: string; name: string | null }>).map((r) => ({ id: r.id, name: r.name ?? r.id }));
}

// 액트 체크(7) 라인급 기본값 = 전체 체크(§4 경험 명시 규칙을 info/club 에도 통일 적용).
//   저장값(actCheck.<hub>[id]) 이 boolean 이면 우선. 액트 체크는 읽기전용 모니터링 → 결과/포인트/snapshot 무영향.
function mergeActCheck(
  groups: Array<{ id: string; name: string }>,
  saved: Record<string, boolean> | undefined,
): ActCheckLineGroup[] {
  return groups.map((g) => ({
    lineGroupId: g.id,
    name: g.name,
    checked: typeof saved?.[g.id] === "boolean" ? saved![g.id] : true,
  }));
}

export async function loadTeamPartsInfoWeekDetail(opts: {
  weekId: string;
  organization: OrganizationSlug;
  mode: ScopeMode;
  today?: string;
}): Promise<TeamPartsInfoWeekDetailData> {
  const { weekId, organization, mode, today } = opts;

  const { rows } = await loadSeasonWeeks(today);
  const managedRow = rows.find((r) => r.week_id === weekId) ?? null;
  if (!managedRow) throw new WeekDetailNotFoundError();
  const currentRow = rows.find((r) => r.is_current_week) ?? null;

  const [
    { config: saved, openConfirmed },
    reviewed,
    isExpansionWeek,
    infoCatalog,
    teams,
    infoLineGroups,
    expLineGroups,
    clubLineGroups,
    weekRecognitionCount,
  ] = await Promise.all([
    loadWeekOpeningConfig(weekId, organization),
    loadReviewed(weekId),
    loadIsExpansionWeek(organization, managedRow.week_start_date, managedRow.week_end_date),
    loadInfoLineCatalog(),
    listTeams(organization, mode),
    loadProcessLineGroups("info"),
    loadProcessLineGroups("experience"),
    loadProcessLineGroups("club"),
    loadWeekRecognitionCount(weekId, organization),
  ]);

  // ── (2) 라인 개설(8) — 실무 정보: 기본 unchecked, 저장값(practicalInfo) 우선(기존 동작 불변). ──
  const savedInfo = saved?.practicalInfo ?? {};
  const lineOpeningInfo: OpeningInfoLine[] = infoCatalog.map((l) => ({
    lineId: l.lineId,
    lineName: l.lineName,
    checked: savedInfo[l.lineId] === true,
  }));

  // ── (4) 라인 개설(8) — 실무 경험: 기존 5카테고리·기본값(도출/분석/견문/관리=true·확장=isExpansionWeek). ──
  const savedExp = saved?.practicalExperience ?? {};
  const lineOpeningExperience: OpeningExperienceTeam[] = teams.map((t) => {
    const savedTeam = savedExp[t.id] ?? {};
    return {
      teamId: t.id,
      teamName: t.teamName,
      lines: EXPERIENCE_LINE_TYPES.map((type) => {
        const def = type === "expansion" ? isExpansionWeek : true;
        const savedVal = savedTeam[type];
        return { type, checked: typeof savedVal === "boolean" ? savedVal : def };
      }),
    };
  });

  // ── (1)(3)(6) 라인급(체크) → 액트 체크(7). process_line_groups + config.actCheck(기본 전체 체크). ──
  const savedAct = saved?.actCheck ?? {};
  const actCheckInfo = mergeActCheck(infoLineGroups, savedAct.info);
  const actCheckExperience: ActCheckExperienceTeam[] = teams.map((t) => ({
    teamId: t.id,
    teamName: t.teamName,
    lineGroups: mergeActCheck(expLineGroups, savedAct.experience?.[t.id]),
  }));
  const actCheckClub = mergeActCheck(clubLineGroups, savedAct.club);

  // ── (5) 실무 역량 — 정상 진행(공유·기본 checked). ──
  const practicalCompetency: OpeningCompetency = {
    checked:
      typeof saved?.practicalCompetency?.checked === "boolean"
        ? saved.practicalCompetency.checked
        : true,
  };

  const todayIso = today ?? getCurrentActivityDateIso();

  // 주차 진행 단계 — 공통 판정 재사용(별도 날짜식 신설 금지):
  //   현재 = loadSeasonWeeks 가 이미 계산한 managedRow.is_current_week(isCurrentWeek, 동일 todayIso).
  //   과거 = 현재 아님 && 관리 주차 종료일 < 오늘. 그 외(종료일 미래/미상) = 미래.
  const weekPhase: "past" | "current" | "future" = managedRow.is_current_week
    ? "current"
    : managedRow.week_end_date != null && managedRow.week_end_date < todayIso
      ? "past"
      : "future";

  return {
    currentWeek: {
      todayLabel: formatTodayLabel(todayIso),
      seasonWeekName: currentRow ? weekBannerName(currentRow) : null,
      weekRangeLabel: currentRow ? weekRangeLabel(currentRow) : null,
      activityStatus: currentRow ? activityStatusOf(currentRow) : null,
    },
    managedWeek: {
      weekId,
      weekName: weekTableName(managedRow),
      weekBannerName: weekBannerName(managedRow),
      weekRangeLabel: weekRangeLabel(managedRow),
      activityStatus: activityStatusOf(managedRow),
      reviewed,
      openConfirmed,
      weekPhase,
      isExpansionWeek,
      weekRecognitionCount,
    },
    openingConfig: {
      actCheck: { info: actCheckInfo, experience: actCheckExperience, club: actCheckClub },
      lineOpening: { practicalInfo: lineOpeningInfo, practicalExperience: lineOpeningExperience },
      practicalCompetency,
    },
  };
}

// ── 쓰기: 오픈 확인 ────────────────────────────────────────────────────────────
export class WeekDetailWriteError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "WeekDetailWriteError";
  }
}

// 체크 상태를 정규화(허용 키만 boolean 으로). config jsonb 로 저장할 순수 객체.
function normalizeConfig(input: unknown): SavedConfig {
  const src = (input ?? {}) as Record<string, unknown>;
  const out: SavedConfig = {};

  const info = src.practicalInfo;
  if (info && typeof info === "object") {
    const m: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(info as Record<string, unknown>)) m[k] = v === true;
    out.practicalInfo = m;
  }

  const exp = src.practicalExperience;
  if (exp && typeof exp === "object") {
    const m: Record<string, Partial<Record<ExperienceLineType, boolean>>> = {};
    for (const [teamId, lines] of Object.entries(exp as Record<string, unknown>)) {
      if (!lines || typeof lines !== "object") continue;
      const lm: Partial<Record<ExperienceLineType, boolean>> = {};
      for (const type of EXPERIENCE_LINE_TYPES) {
        const v = (lines as Record<string, unknown>)[type];
        if (typeof v === "boolean") lm[type] = v;
      }
      m[teamId] = lm;
    }
    out.practicalExperience = m;
  }

  const comp = src.practicalCompetency;
  if (comp && typeof comp === "object") {
    out.practicalCompetency = { checked: (comp as Record<string, unknown>).checked === true };
  }

  // 액트 체크(7) 선택 — actCheck.{info,club} = {lineGroupId:bool}, actCheck.experience = {teamId:{lineGroupId:bool}}.
  const act = src.actCheck;
  if (act && typeof act === "object") {
    const a = act as Record<string, unknown>;
    const boolMap = (v: unknown): Record<string, boolean> => {
      const m: Record<string, boolean> = {};
      if (v && typeof v === "object") for (const [k, val] of Object.entries(v as Record<string, unknown>)) m[k] = val === true;
      return m;
    };
    const outAct: NonNullable<SavedConfig["actCheck"]> = {};
    if (a.info && typeof a.info === "object") outAct.info = boolMap(a.info);
    if (a.club && typeof a.club === "object") outAct.club = boolMap(a.club);
    if (a.experience && typeof a.experience === "object") {
      const m: Record<string, Record<string, boolean>> = {};
      for (const [teamId, lg] of Object.entries(a.experience as Record<string, unknown>)) m[teamId] = boolMap(lg);
      outAct.experience = m;
    }
    out.actCheck = outAct;
  }

  return out;
}

// [오픈 확인] — 체크 상태를 주차×클럽 오픈 설정으로 저장하고 open_confirmed=true. review 와 무관.
//   snapshot 무접촉(cluster4_week_opening_configs 만 write).
export async function saveWeekOpenConfirm(opts: {
  weekId: string;
  organization: OrganizationSlug;
  config: unknown;
  actorId?: string | null;
}): Promise<{ openConfirmed: true; weekRecognitionCount: number | null }> {
  const { weekId, organization, config, actorId } = opts;

  // 관리 주차 존재 확인.
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekDetailWriteError(500, wkErr.message);
  if (!wk) throw new WeekDetailWriteError(404, "주차를 찾을 수 없습니다.");

  const normalized = normalizeConfig(config);

  // [주차별 인정 개수 N] — §4 원자성: 모든 DB write 전에 조회·미설정 검증·계산을 먼저 끝낸다.
  //   featureAvailable(포인트 config 테이블 && recognition 컬럼 둘 다 적용)일 때만:
  //     · 오픈 라인 중 미설정(config row 부재/NULL) 항목이 있으면 fail-closed(422) → 아무것도 저장 안 함.
  //     · A/B/N 을 오픈확인 config 와 동일 upsert 에 병합 → 단일 원자 write("오픈확인 성공+N 실패" 반쪽 방지).
  //   미적용(마이그 전)이면 A/B/N 필드를 생략 → 기존 오픈확인 흐름 유지(무회귀). snapshot 무접촉.
  const recognition = await prepareWeekRecognition({ weekId, organization, config: normalized });
  if (recognition.featureAvailable && recognition.missing.length > 0) {
    throw new WeekDetailWriteError(422, formatMissingPointConfigMessage(recognition.missing));
  }

  const upsertRow: Record<string, unknown> = {
    week_id: weekId,
    organization_slug: organization,
    config: normalized as unknown as Record<string, unknown>,
    open_confirmed: true,
    open_confirmed_at: new Date().toISOString(),
    open_confirmed_by: actorId ?? null,
    ...(recognition.featureAvailable ? recognitionUpsertFields(recognition.result) : {}),
  };
  const { error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .upsert(upsertRow, { onConflict: "week_id,organization_slug" });
  if (error) {
    // 테이블 미적용(마이그레이션 필요) 등.
    throw new WeekDetailWriteError(500, `오픈 설정 저장 실패: ${error.message}`);
  }
  // 화면 즉시 갱신용 — featureAvailable 이면 방금 확정된 N, 미적용이면 null(UI 는 기본값 폴백).
  return {
    openConfirmed: true,
    weekRecognitionCount: recognition.featureAvailable ? recognition.result.recognitionCountN : null,
  };
}

// [오픈 확인 취소] — ↩ 실행 취소 = 직전 단계("오픈 확인 전") 복원.
//   open_confirmed=true → false 로만 되돌린다(config jsonb 는 보존 → 재확인 시 동일 설정 복귀).
//   saveWeekOpenConfirm 과 동일 SoT(cluster4_week_opening_configs)·snapshot 무접촉.
//   멱등: 이미 false 이거나 행이 없으면 0행 갱신 → reverted:false 로 성공 반환(중복 취소 안전).
export async function revertWeekOpenConfirm(opts: {
  weekId: string;
  organization: OrganizationSlug;
  actorId?: string | null;
}): Promise<{ openConfirmed: false; reverted: boolean }> {
  const { weekId, organization } = opts;

  // 관리 주차 존재 확인(saveWeekOpenConfirm 과 대칭).
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekDetailWriteError(500, wkErr.message);
  if (!wk) throw new WeekDetailWriteError(404, "주차를 찾을 수 없습니다.");

  const { data, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .update({
      open_confirmed: false,
      open_confirmed_at: null,
      open_confirmed_by: null,
    })
    .eq("week_id", weekId)
    .eq("organization_slug", organization)
    .eq("open_confirmed", true) // 멱등 가드: 이미 취소/미확인이면 0행.
    .select("week_id");
  if (error) {
    throw new WeekDetailWriteError(500, `오픈 확인 취소 실패: ${error.message}`);
  }
  // 인정 개수 N 무효화(오픈확인 row 와 동일 생명주기). 컬럼 미적용이면 조용히 skip.
  await clearWeekRecognition({ weekId, organization });
  return { openConfirmed: false, reverted: (data ?? []).length > 0 };
}

// [검수 완료] 응답 — 이 주차가 최종 확정(공표+검수) 상태가 됐음을 알린다.
export type TeamPartsWeekReviewResult = {
  weekId: string;
  reviewed: true;
  reviewedAt: string;
  publishedAt: string;
  // 최초 클릭 여부 구분(멱등 재클릭 시 true) — 응답 소비처가 "새로 확정"과 "이미 확정"을 구분할 수 있게.
  alreadyPublished: boolean;
  alreadyReviewed: boolean;
  // 코호트(그 주차 user_week_statuses 보유자) weekly-cards snapshot 재계산 결과.
  snapshotRecompute: { requested: number; recomputed: number; failed: number };
  // uws 확정 결과(2026-summer+ 운영 주차). 레거시/공식휴식/현재미래 주차는 skipped=true.
  uwsFinalize: FinalizeUwsResult | null;
};

// [검수 완료] — 이 주차의 결과를 "최종 확정"한다(액트 체크/라인 개설 검토 후 크루 결과 반영).
//
//   weekly-card-finalization 과 동일 개념·동일 단일 SoT 를 재사용한다(새 기준/새 데이터 없음):
//     1) 공표(publish)      = weeks.result_published_at (미공표면 markWeekResultPublished, 이미 공표면 멱등)
//                             → 크루 주차 카드가 tallying(집계 중) → user_week_statuses.status 기준
//                               success(성장 성공)/fail(성장 실패)로 전환된다.
//     2) 코호트 재계산       = recomputeCohortSnapshots (그 주차 uws 보유자 전원 카드 1회 재계산, c=8)
//                             → snapshot-only 조회 구조에서 크루 카드가 즉시 최신 결과를 반영.
//                             ⚠ 공표 SoT 쓰기와 분리해 코호트를 "단일 패스"로만 재계산한다 — affected
//                               (uws 생성/갱신)는 이 코호트의 부분집합이라 이중 재계산하지 않는다.
//     3) 검수 완료(reviewed) = weeks.result_reviewed_at (주차 검수 컬럼·상세 V 신호 + /weekly-ranking 라벨)
//
//   불변식:
//     - user_week_statuses.status(성장 성공/실패 SoT)는 절대 건드리지 않는다 — 공표는 "표시 가능 상태"로
//       전환하는 이벤트일 뿐, 결과 판정 자체는 기존 계산 경로가 소유한다.
//     - 주차 전역(org 무관) 확정. 멱등 — 이미 확정된 주차 재클릭 시 코호트만 재계산(재확정 효과).
//     - operating SoT(weeks)만 쓴다 — 목록/상세의 주차 검수 V 가 weeks 를 직접 읽으므로(mode 무관 동일
//       값) 여기도 동일 저장소를 써야 새로고침 후 V 가 유지된다. mode 는 액트/라인 관리 팀 스코프에만 영향.
export async function markTeamPartsWeekReviewed(
  weekId: string,
  actor: string | null = null,
  opts: { scope?: StateScope; allowIncompleteTestData?: boolean } = {},
): Promise<TeamPartsWeekReviewResult> {
  // scope: operating(기본, 실유저·운영 weeks) / qa(mode=test·테스트 코호트·qa_weeks_state).
  //   allowIncompleteTestData 는 finalizeWeekUws 내부에서 test/QA 스코프일 때만 안전장치를 bypass 한다.
  const scope: StateScope = opts.scope ?? "operating";
  // 0) 주차 존재 + 현재 공표/검수 상태 + uws 확정에 필요한 메타.
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at",
    )
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekDetailWriteError(500, wkErr.message);
  if (!wk) throw new WeekDetailWriteError(404, "주차를 찾을 수 없습니다.");
  const week = wk as {
    id: string;
    start_date: string | null;
    end_date: string | null;
    season_key: string | null;
    iso_year: number | null;
    iso_week: number | null;
    is_official_rest: boolean | null;
    result_published_at: string | null;
    result_reviewed_at: string | null;
  };

  // 0.5) uws 확정 (공표 선행!) — 2026-summer+ 운영 주차의 코호트 verdict 를 user_week_statuses 로
  //   persist 한다. 레거시/공식휴식/현재·미래 주차는 내부에서 skip. 적립 미완료(전원 0점 fail 위험)·
  //   평가 미입력(pending) 이면 여기서 422 로 차단해 공표/검수를 진행하지 않는다(사고 방지).
  //   ⚠ 반드시 공표 전 — 공표의 코호트 스냅샷 재계산이 이 uws 를 읽어 카드를 success/fail 로 굳힌다.
  let uwsFinalize: FinalizeUwsResult;
  try {
    uwsFinalize = await finalizeWeekUws(
      {
        id: week.id,
        start_date: week.start_date,
        end_date: week.end_date,
        season_key: week.season_key,
        iso_year: week.iso_year,
        iso_week: week.iso_week,
        is_official_rest: week.is_official_rest,
      },
      scope,
      actor,
      { allowIncompleteTestData: opts.allowIncompleteTestData },
    );
  } catch (e) {
    if (e instanceof UwsFinalizeBlockedError) {
      // 적립 미완료 / 평가 미입력 / 라인 미개설 mass-fail → 관리자 안내 후 중단(공표·검수 미실행).
      throw new WeekDetailWriteError(e.status, e.message);
    }
    throw e;
  }

  // 0.7) 현재/미래 주차 가드 (2026-07-09) — 진행 중인 주차는 검수 완료 불가.
  //   finalizeWeekUws 가 current_or_future_week 로 skip 하면 uws 가 생기지 않는데(현재 주차는
  //   resolver 가 항상 running 으로 판정), 그대로 공표까지 진행하면 그 주차가 과거로 넘어가는 순간
  //   "published + uws 없음"이 되어 카드가 no_data 로 드롭되는 미래 사고를 예약하게 된다.
  //   → 여기서 명시 차단해 공표·검수를 실행하지 않는다(안내 후 종료). 레거시/공식휴식/빈 코호트
  //     skip 은 과거·유효 주차라 종전대로 공표 진행(카드 드롭 위험 없음 — uws 이관본/휴식 판정 존재).
  if (uwsFinalize.skipped && uwsFinalize.skipReason === "current_or_future_week") {
    throw new WeekDetailWriteError(
      422,
      "현재 진행 중인 주차는 아직 검수 완료할 수 없습니다. 주차가 종료된 후 검수 완료를 진행해주세요.",
    );
  }

  // 1) 공표(publish) — SoT 쓰기만 하고, 코호트 snapshot 재계산은 아래에서 "단일 패스"로 수행한다.
  //   ⚠ 이중 재계산 제거(2026-07-09 실측): 종전에는 publishWeekResult 가 코호트 전원을 c=3 로
  //     재계산하고, 곧바로 1.5) 가 affected(코호트의 부분집합)를 c=8 로 다시 재계산 → 같은 85명을
  //     두 번 계산했다. 이제 공표 SoT 쓰기(markWeekResultPublished)와 코호트 재계산을 분리해,
  //     코호트 전원을 c=8 로 한 번만 재계산한다.
  const alreadyPublished = week.result_published_at != null;
  let publishedAt = week.result_published_at;
  let snapshotRecompute = { requested: 0, recomputed: 0, failed: 0 };
  if (!alreadyPublished) {
    try {
      const pub = await markWeekResultPublished(weekId, scope, actor);
      publishedAt = pub.row.result_published_at ?? pub.nowIso;
    } catch (e) {
      if (e instanceof WeekResultPublishError) {
        // 409 = 그 사이 다른 요청이 공표함(race) → 최신 공표시각만 재조회하고 아래 단일 재계산으로 진행(멱등).
        if (e.status === 409) {
          const { data } = await supabaseAdmin
            .from("weeks").select("result_published_at").eq("id", weekId).maybeSingle();
          publishedAt = (data as { result_published_at: string | null } | null)?.result_published_at ?? publishedAt;
        } else {
          throw new WeekDetailWriteError(e.status, e.message);
        }
      } else {
        throw e;
      }
    }
    // 단일 snapshot 패스: 그 주차 uws 보유자(=코호트) 전원을 c=8 로 한 번만 재계산한다.
    //   공표로 카드가 tallying→success/fail 로 굳으므로 코호트 전원 재계산이 필요하고,
    //   affectedUserIds(생성/갱신된 uws)는 이 코호트의 부분집합이라 별도 재계산이 불필요하다(이중 제거).
    //   best-effort — recomputeCohortSnapshots 는 내부에서 실패를 격리(카운트 반환)하고 throw 하지 않는다.
    snapshotRecompute = await recomputeCohortSnapshots(week.start_date, scope, {
      concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
    });
  }
  // 이미 공표된 주차(재클릭)는 위 단일 패스를 타지 않는다 — 성장 성공/실패 SoT(user_week_statuses)는
  //   검수로 바뀌지 않으므로 코호트 전원 재계산이 불필요. 단, uws 가 실제 바뀐 affected 만 아래에서 보정.

  // 1.5) 사후 캐시 재계산.
  //   - snapshot: 신규 공표(!alreadyPublished)면 위 단일 패스가 코호트 전원(affected 포함)을 이미
  //     재계산했으므로 여기서 재실행하지 않는다(이중 제거). 재클릭(공표 스킵)일 때만, uws 가 실제
  //     바뀐 affected 를 재계산해 카드 정합을 맞춘다(공통 케이스는 affected 0 → no-op).
  //   - user_growth_stats(누적/졸업): 공표/코호트 재계산 경로가 갱신하지 않으므로, uws 가 바뀐
  //     affected 사용자만 항상 재계산한다(저렴 — 유저당 1 SELECT+1 UPSERT).
  if (uwsFinalize.affectedUserIds.length > 0) {
    if (alreadyPublished) {
      try {
        await recomputeWeeklyCardsSnapshotsForUsers(uwsFinalize.affectedUserIds, {
          concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
        });
      } catch (e) {
        console.warn("[team-parts/review] affected snapshot 재계산 실패(격리)", {
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // 성장 캐시 재계산 — 직렬 for-await(N×100ms 누적) 대신 제한 동시성 병렬(best-effort).
    await recalcUserGrowthStatsForUsers(uwsFinalize.affectedUserIds, {
      concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
    });
  }

  // 2) 검수 완료(reviewed) — 공표 선행 완료 상태에서 result_reviewed_at 세팅.
  const alreadyReviewed = week.result_reviewed_at != null;
  let reviewedAt = week.result_reviewed_at;
  if (!alreadyReviewed) {
    try {
      const rev = await markWeekResultReviewed(weekId, scope, actor);
      reviewedAt = rev.result_reviewed_at;
    } catch (e) {
      if (e instanceof WeekResultReviewError) {
        // 409 = 이미 검수됨(race) → 최신 값 재조회로 멱등 처리.
        if (e.status === 409) {
          const { data } = await supabaseAdmin
            .from("weeks").select("result_reviewed_at").eq("id", weekId).maybeSingle();
          reviewedAt = (data as { result_reviewed_at: string | null } | null)?.result_reviewed_at ?? reviewedAt;
        } else {
          throw new WeekDetailWriteError(e.status, e.message);
        }
      } else {
        throw e;
      }
    }
  }

  return {
    weekId,
    reviewed: true,
    reviewedAt: reviewedAt ?? new Date().toISOString(),
    publishedAt: publishedAt ?? new Date().toISOString(),
    alreadyPublished,
    alreadyReviewed,
    snapshotRecompute,
    uwsFinalize,
  };
}

// [주차 검수 실행 취소] — markTeamPartsWeekReviewed(공표+검수) 실행 직전 상태로 복원.
//   result_published_at=NULL + result_reviewed_at=NULL + 코호트 snapshot 재계산 → 카드 success/fail→tallying.
//   weekId → (season_key, week_number) 로 해석해 공용 revertWeeklyCardFinalization(rollback 로직)을 재사용한다.
//   scope: operating(기본)=운영 weeks · qa=qa_weeks_state 오버레이(테스트 코호트·안전 검증용).
export async function revertTeamPartsWeekReview(
  weekId: string,
  scope: StateScope = "operating",
  actor: string | null = null,
): Promise<{ weekId: string; reverted: boolean; publishedAt: string | null; reviewedAt: string | null; snapshotRecompute: { requested: number; recomputed: number; failed: number }; uwsRevert: Awaited<ReturnType<typeof revertWeekUws>> }> {
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number")
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekDetailWriteError(500, wkErr.message);
  const w = wk as { season_key: string | null; week_number: number | null } | null;
  if (!w?.season_key || w.week_number == null) {
    throw new WeekDetailWriteError(404, "주차(season/weekNumber)를 찾을 수 없습니다.");
  }

  // 0) uws 확정 역연산 (검수 완료가 생성/갱신한 uws 되돌리기) — 공표 해제보다 먼저.
  //   생성분 DELETE + 갱신분 prev_status 복원. run-log(cluster4_week_finalize_runs) provenance 기준.
  //   ⚠ revertWeeklyCardFinalization 의 코호트 재계산은 "현재 uws 보유자" 기준이라, 삭제된 uws 의
  //   사용자는 그 재계산에 안 잡힌다 → 아래에서 affected 를 명시 재계산해 카드가 skeleton/집계중으로 복귀.
  const uwsRevert = await revertWeekUws(weekId);

  // 1) 공용 rollback 로직 재사용(공표/검수 해제 + 코호트 재계산).
  const r = await revertWeeklyCardFinalization({
    seasonKey: w.season_key,
    weekNumber: w.week_number,
    org: null,
    scope,
    actor,
  });

  // 2) 삭제/복원된 uws 사용자의 snapshot + 성장 캐시 재계산 (카드/누적 원복).
  //   revertWeekUws 가 uws 를 먼저 지우므로 revertWeeklyCardFinalization 의 코호트(=현재 uws 보유자)에는
  //   이들이 안 잡힌다 → 여기서 명시 재계산해야 카드가 집계중으로 복귀한다(이중 재계산 아님).
  //   snapshot 1건 ≈ 5s 라 코호트가 크면 여기가 벽시계를 지배 → 제한 동시성 병렬(3→8)로 단축.
  if (uwsRevert.affectedUserIds.length > 0) {
    try {
      await recomputeWeeklyCardsSnapshotsForUsers(uwsRevert.affectedUserIds, {
        concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
      });
    } catch (e) {
      console.warn("[team-parts/review revert] affected snapshot 재계산 실패(격리)", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
    // 성장 캐시 재계산 — 직렬 for-await 대신 제한 동시성 병렬(best-effort).
    await recalcUserGrowthStatsForUsers(uwsRevert.affectedUserIds, {
      concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
    });
  }

  return {
    weekId,
    reverted: r.reverted || uwsRevert.reverted,
    publishedAt: r.published?.resultPublishedAt ?? null,
    reviewedAt: null,
    snapshotRecompute: r.snapshotRecompute,
    uwsRevert,
  };
}
