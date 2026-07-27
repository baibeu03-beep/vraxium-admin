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
//   · 실무 정보 라인              = listInfoLineCatalog(org) — 정본 9종 + 등록된 신규 정보 라인
//   · 실무 경험 팀                = listTeams(org, mode) (cluster4_teams, (T) 스코프)
//
// 기본 체크 정책:
//   · 실무 정보  : 전부 unchecked
//   · 실무 경험  : 도출·분석·견문·관리 checked, 확장 = unchecked(false)
//   · 실무 역량  : 항상 checked
//   · 실무 경력  : 데이터 없음(DTO 미포함)
//   저장된 config 가 있으면 해당 값으로 덮어쓴다(없는 키는 기본값 유지).
//
// ⚠ 확장(expansion) 라인의 단일 SoT = 관리자가 이 화면에서 저장한 명시적 값
//   (cluster4_week_opening_configs.config.practicalExperience.<teamId>.expansion) 뿐이다.
//   과거에는 저장값이 없을 때 cluster4_experience_extension_periods(= /admin/season-weeks 의
//   [실무 경험] > 확장 류 라인 과 동일 원장) 기간 겹침으로 확장을 자동 체크했으나, 이 자동 파생
//   경로를 제거했다 — season-weeks 확장 기간이 바뀌어도 이 화면의 확장 체크에는 영향이 없다.
//   저장값이 없는 주차의 확장 기본값은 항상 미체크(false).
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
import { listInfoLineCatalog } from "@/lib/adminInfoLineCatalog";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";
import type { StateScope } from "@/lib/operationalState";
// 확정/확정 취소 본체 = 공통 서비스 단일 SoT(공표 경로와 공유 · 로직 복제 금지).
import {
  finalizeWeekResultCore,
  revertWeekResultCore,
  WeekResultFinalizeError,
  type WeekResultFinalizeResult,
  type WeekResultRevertResult,
} from "@/lib/weekResultFinalizeCore";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
  type WeekOrgResultStatus,
  type OrgResultScope,
} from "@/lib/weekOrgResultState";
import {
  prepareWeekRecognition,
  recognitionUpsertFields,
  formatMissingPointConfigMessage,
  clearWeekRecognition,
  loadWeekRecognitionCount,
} from "@/lib/weekRecognitionResolve";
import { resolveReopenEligibility } from "@/lib/weekReopenPolicy";
import { loadWeekOpeningTimeline } from "@/lib/weekOpeningTimeline";
import { RECOGNITION_CALC_VERSION } from "@/lib/weekRecognitionCount";

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
    // 조직별 검수 상태(현재 선택 조직 기준) — aggregating(집계 중)/reviewing(검수 중)/published(검수 완료).
    //   SoT = cluster4_week_org_result_states. 전역 result_reviewed_at 을 직접 보지 않는다.
    reviewStatus: WeekOrgResultStatus;
    // 하위호환·액션 게이트용 파생값(= reviewStatus === "published").
    reviewed: boolean;
    // [오픈 확인] 저장 여부(주차×클럽). GET 시 V 표시 복원용.
    openConfirmed: boolean;
    // 주차 진행 단계(과거/현재/미래) — 프로젝트 공통 주차 판정 재사용(loadSeasonWeeks 의 is_current_week +
    //   동일 today/날짜 비교). 과거 주차 오픈 상태 변경 시 확인 모달을 띄우는 UI 게이트용(로직 무영향·표시 힌트).
    weekPhase: "past" | "current" | "future";
    // 주차별 활동 인정 개수 N(오픈확인 시점 확정 저장값). 인정 컬럼 미적용/미계산이면 null →
    //   프론트가 Phase1 기본값(DEFAULT_WEEK_RECOGNITION_COUNT)으로 폴백.
    weekRecognitionCount: number | null;
    // [오픈 확인] 재실행 허용 여부 — 이미 확인된 주차를 "다시 확인"할 수 있는가(N주 목요일 00:01 KST
    //   이전 && 검수 미완료). 서버 강제(saveWeekOpenConfirm)와 동일 정책(resolveReopenEligibility) 공유 —
    //   UI 버튼 비활성/안내용. 최초 확인(openConfirmed=false)은 이 값과 무관하게 항상 가능.
    reopenable: boolean;
    reopenBlockedReason: string | null;
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

// 조직별 검수 상태 — (week_id, organization) 조직별 상태 테이블이 SoT(aggregating/reviewing/published).
//   행 없으면 resolveWeekOrgResultState 로 판정(레거시 주차는 전역 result_reviewed_at 폴백).
//   전역 result_reviewed_at 을 직접 보지 않는다 — 한 조직만 검수해도 세 조직이 "검수 완료"로 뜨던 버그 방지.
async function loadReviewStatus(
  weekId: string,
  organization: OrganizationSlug,
  scope: OrgResultScope,
  startDate: string | null,
): Promise<WeekOrgResultStatus> {
  const [orgStates, legacy] = await Promise.all([
    loadWeekOrgResultStates([weekId], organization, scope),
    supabaseAdmin
      .from("weeks")
      .select("result_reviewed_at")
      .eq("id", weekId)
      .maybeSingle(),
  ]);
  if (legacy.error) {
    console.warn("[team-parts/info/weeks/detail] result_reviewed_at read unavailable:", legacy.error.message);
  }
  const legacyReviewed =
    (legacy.data as { result_reviewed_at: string | null } | null)?.result_reviewed_at != null;
  return resolveWeekOrgResultState(orgStates.get(weekId), startDate ?? "", legacyReviewed).status;
}

// 실무 정보 라인 개설(8) 카탈로그 — practical-info · 라인 개설 관리와 **동일 함수**(listInfoLineCatalog).
//   키=activity_type id(개설 판정 회로 cluster4_lines.activity_type_id 와 조인·불변),
//   표시명=등록 원장 line_name.
//   ⚠ 종전 구현은 activity_types(정렬) 와 line_registrations(line_code 정렬) 를 **위치(index)로**
//     맞췄다. 등록 라인이 10개째로 늘거나 line_code 가 IFBS-* 보다 앞서면 9개 라인명이 통째로
//     한 칸씩 밀리는 구조였다. 이제 point_activity_type_id 로 실제 조인한다(위치 매칭 폐기).
async function loadInfoLineCatalog(
  organization: OrganizationSlug,
): Promise<Array<{ lineId: string; lineName: string }>> {
  return (await listInfoLineCatalog(organization)).map((l) => ({
    lineId: l.lineId,
    lineName: l.lineName,
  }));
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

// 액트 체크(7) 라인급 병합 — 저장값(actCheck.<hub>[id]) 이 boolean 이면 우선, 없으면 defaultChecked.
//   기본값 정책(2026-07-20): [실무 정보] 라인 급(체크)= 미체크(false) — 신규 주차는 관리자가 수동으로
//   오픈 확인(체크)하기 전까지 아무것도 오픈되지 않은 상태가 기본이다. 실무 경험/클럽 라인급은 기존
//   정책(전체 체크) 유지. 액트 체크는 읽기전용 모니터링 게이트 → 결과/포인트/snapshot 무영향.
function mergeActCheck(
  groups: Array<{ id: string; name: string }>,
  saved: Record<string, boolean> | undefined,
  defaultChecked: boolean,
): ActCheckLineGroup[] {
  return groups.map((g) => ({
    lineGroupId: g.id,
    name: g.name,
    checked: typeof saved?.[g.id] === "boolean" ? saved![g.id] : defaultChecked,
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
    reviewStatus,
    infoCatalog,
    teams,
    infoLineGroups,
    expLineGroups,
    clubLineGroups,
    weekRecognitionCount,
  ] = await Promise.all([
    loadWeekOpeningConfig(weekId, organization),
    loadReviewStatus(weekId, organization, resolveOrgResultScope(mode), managedRow.week_start_date),
    loadInfoLineCatalog(organization),
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

  // ── (4) 라인 개설(8) — 실무 경험: 기존 5카테고리. ──
  //   기본값(저장값 없을 때): 도출/분석/견문/관리=true, 확장=false(미체크).
  //   확장은 season-weeks 확장 기간을 더 이상 참조하지 않는다 — 저장된 명시값만이 SoT.
  const savedExp = saved?.practicalExperience ?? {};
  const lineOpeningExperience: OpeningExperienceTeam[] = teams.map((t) => {
    const savedTeam = savedExp[t.id] ?? {};
    return {
      teamId: t.id,
      teamName: t.teamName,
      lines: EXPERIENCE_LINE_TYPES.map((type) => {
        const def = type === "expansion" ? false : true;
        const savedVal = savedTeam[type];
        return { type, checked: typeof savedVal === "boolean" ? savedVal : def };
      }),
    };
  });

  // ── (1)(3)(6) 라인급(체크) → 액트 체크(7). process_line_groups + config.actCheck. ──
  //   실무 정보(1) 기본 미체크(신규 주차 오픈 안 됨 정책). 경험(3)/클럽(6)은 기존 기본 전체 체크 유지.
  const savedAct = saved?.actCheck ?? {};
  const actCheckInfo = mergeActCheck(infoLineGroups, savedAct.info, false);
  const actCheckExperience: ActCheckExperienceTeam[] = teams.map((t) => ({
    teamId: t.id,
    teamName: t.teamName,
    lineGroups: mergeActCheck(expLineGroups, savedAct.experience?.[t.id], true),
  }));
  const actCheckClub = mergeActCheck(clubLineGroups, savedAct.club, true);

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
      reviewStatus,
      reviewed: reviewStatus === "published",
      openConfirmed,
      weekPhase,
      weekRecognitionCount,
      ...(() => {
        // 재실행 허용 = 목요일 00:01 KST 이전 && 검수 미완료(published 아님). 서버 강제와 동일 SoT.
        const elig = resolveReopenEligibility({
          weekStartIso: managedRow.week_start_date,
          reviewStatus,
        });
        return { reopenable: elig.reopenable, reopenBlockedReason: elig.reason };
      })(),
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

// [오픈 확인] 재실행 허용 상태 — 서버 강제(라우트 409)와 DTO/UI 가 공유하는 단일 판정.
//   openConfirmed=true(이미 확인됨)이고 reopenable=false 면 재실행을 차단해야 한다(목요일 00:01 KST
//   경과 또는 검수 완료). 최초 확인(openConfirmed=false)은 이 게이트 대상이 아니다.
//   scope = resolveOrgResultScope(mode) — 통합 화면 DTO(loadReviewStatus)와 동일 scope 로 대칭.
export async function loadWeekReopenState(opts: {
  weekId: string;
  organization: OrganizationSlug;
  mode: ScopeMode;
}): Promise<{ openConfirmed: boolean; reopenable: boolean; reopenBlockedReason: string | null }> {
  const [{ openConfirmed }, wk] = await Promise.all([
    loadWeekOpeningConfig(opts.weekId, opts.organization),
    supabaseAdmin.from("weeks").select("start_date").eq("id", opts.weekId).maybeSingle(),
  ]);
  const startDate = (wk.data as { start_date: string | null } | null)?.start_date ?? null;
  const reviewStatus = await loadReviewStatus(
    opts.weekId,
    opts.organization,
    resolveOrgResultScope(opts.mode),
    startDate,
  );
  const elig = resolveReopenEligibility({ weekStartIso: startDate, reviewStatus });
  return { openConfirmed, reopenable: elig.reopenable, reopenBlockedReason: elig.reason };
}

// [오픈 확인] — 체크 상태를 주차×클럽 오픈 설정으로 저장하고 open_confirmed=true. review 와 무관.
//   재실행 시 버전 이력(cluster4_week_opening_config_versions)에 append + 최신 config 갱신(원자 RPC).
//   snapshot 무접촉. 과거 체크/포인트 기록 삭제·재생성 없음(config·버전만 write).
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

  // 확정 시각 — 저장되는 버전 effective_from == N 계산의 예상 타임라인 경계가 정확히 일치하도록
  //   서버에서 한 번만 계산해 recognition 계산과 RPC 양쪽에 동일 값을 넘긴다(경계 불일치 방지).
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // [주차별 인정 개수 N] — §4 원자성: 모든 DB write 전에 조회·미설정 검증·계산을 먼저 끝낸다.
  //   featureAvailable(포인트 config 테이블 && recognition 컬럼 둘 다 적용)일 때만:
  //     · 오픈 라인 중 미설정(config row 부재/NULL) 항목이 있으면 fail-closed(422) → 아무것도 저장 안 함.
  //     · A/B/N 을 오픈확인 저장과 함께 병합 → 원자 write("오픈확인 성공+N 실패" 반쪽 방지).
  //   재실행 정책: N 은 확정 시각(nowMs) 기준 예상 타임라인(기존 버전 + 이번 확정)으로, 실제 가동 액트
  //   기준으로 계산된다(§8). 미적용(마이그 전)이면 A/B/N 생략 + 단일 config 폴백(무회귀). snapshot 무접촉.
  const recognition = await prepareWeekRecognition({
    weekId,
    organization,
    config: normalized,
    effectiveFromMs: nowMs,
  });
  if (recognition.featureAvailable && recognition.missing.length > 0) {
    throw new WeekDetailWriteError(422, formatMissingPointConfigMessage(recognition.missing));
  }
  const writeReco = recognition.featureAvailable;
  const r = recognition.result;

  // 버전 이력 테이블 적용 여부 probe — 적용됐으면 원자 RPC(버전 append + 최신 config/open_confirmed),
  //   아니면 기존 단일 upsert(무회귀·graceful degradation).
  const timeline = await loadWeekOpeningTimeline(weekId, organization);
  if (timeline.timelineAvailable) {
    const { error } = await supabaseAdmin.rpc("apply_week_open_confirm", {
      p_week_id: weekId,
      p_org: organization,
      p_config: normalized as unknown as Record<string, unknown>,
      p_actor: actorId ?? null,
      p_effective_from: nowIso,
      p_write_recognition: writeReco,
      p_min_points_a: writeReco ? r.minimalA : null,
      p_exec_points_b: writeReco ? r.diligentB : null,
      p_recognition_count_n: writeReco ? r.recognitionCountN : null,
      p_recognition_calc_version: writeReco ? RECOGNITION_CALC_VERSION : null,
    });
    if (error) throw new WeekDetailWriteError(500, `오픈 설정 저장 실패: ${error.message}`);
  } else {
    const upsertRow: Record<string, unknown> = {
      week_id: weekId,
      organization_slug: organization,
      config: normalized as unknown as Record<string, unknown>,
      open_confirmed: true,
      open_confirmed_at: nowIso,
      open_confirmed_by: actorId ?? null,
      ...(writeReco ? recognitionUpsertFields(r) : {}),
    };
    const { error } = await supabaseAdmin
      .from("cluster4_week_opening_configs")
      .upsert(upsertRow, { onConflict: "week_id,organization_slug" });
    if (error) {
      // 테이블 미적용(마이그레이션 필요) 등.
      throw new WeekDetailWriteError(500, `오픈 설정 저장 실패: ${error.message}`);
    }
  }
  // 화면 즉시 갱신용 — featureAvailable 이면 방금 확정된 N, 미적용이면 null(UI 는 기본값 폴백).
  return {
    openConfirmed: true,
    weekRecognitionCount: writeReco ? r.recognitionCountN : null,
  };
}

// [활동 인정 개수 N 미리보기] — 저장하지 않고, 현재(미저장) 오픈 설정 config 로 N 을 계산만 한다.
//   화면의 체크박스 변경마다 호출해 표시 N 을 즉시 재계산하는 용도. saveWeekOpenConfirm 과 **동일한**
//   prepareWeekRecognition(=순수 read+compute, write 없음)을 재사용하므로, 화면 표시 N 과 오픈 확인 시
//   실제 저장/스냅샷/집계에 쓰이는 N 이 산식·입력 해석까지 100% 동일하다(SoT 분기 없음).
//   featureAvailable=false(마이그 전)면 recognitionCountN=null → 호출부가 기존 기본값으로 폴백.
//   org 만 입력(모드 무관) — 일반/mode=test/actAsTestUserId/demoUserId 동일 결과.
export async function previewWeekRecognition(opts: {
  weekId: string;
  organization: OrganizationSlug;
  config: unknown;
}): Promise<{
  featureAvailable: boolean;
  recognitionCountN: number | null;
  minPointsA: number;
  execPointsB: number;
  missing: string[];
}> {
  const normalized = normalizeConfig(opts.config);
  const recognition = await prepareWeekRecognition({
    weekId: opts.weekId,
    organization: opts.organization,
    config: normalized,
  });
  return {
    featureAvailable: recognition.featureAvailable,
    // 저장 흐름과 동일: featureAvailable 일 때만 확정 N, 아니면 null(폴백).
    recognitionCountN: recognition.featureAvailable ? recognition.result.recognitionCountN : null,
    minPointsA: recognition.result.minimalA,
    execPointsB: recognition.result.diligentB,
    missing: recognition.missing.map((m) => `${m.hubLabel}: ${m.label}`),
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
//   DTO 는 공통 서비스(lib/weekResultFinalizeCore)의 반환 타입 그대로다(프론트 호환 유지).
export type TeamPartsWeekReviewResult = WeekResultFinalizeResult;

// [검수 완료] — 레거시 호환 래퍼. 확정 본체는 공통 서비스 finalizeWeekResultCore 하나뿐이다
//   (lib/weekResultFinalizeCore.ts — 단계·순서·멱등 규칙은 그 파일 헤더 참조).
//
//   2026-07-27 이후 정식 진입점은 `클럽 활동 검수(공표)`(publishCrewWeekResult) 이며, 같은 core 를
//   호출한다 — 두 경로가 로직을 복제하지 않는다. 이 함수는 기존 API
//   (POST /api/admin/team-parts/info/weeks/[weekId]/review)의 응답 DTO 호환을 위해 유지한다.
export async function markTeamPartsWeekReviewed(
  weekId: string,
  actor: string | null = null,
  opts: { scope?: StateScope; organization: OrganizationSlug; allowIncompleteTestData?: boolean },
): Promise<TeamPartsWeekReviewResult> {
  try {
    return await finalizeWeekResultCore(weekId, actor, opts);
  } catch (e) {
    // 라우트가 기대하는 에러 타입으로만 변환한다(상태코드·문구 불변).
    if (e instanceof WeekResultFinalizeError) throw new WeekDetailWriteError(e.status, e.message);
    throw e;
  }
}

// [주차 검수 실행 취소] — 레거시 호환 래퍼. 롤백 본체는 공통 서비스 revertWeekResultCore 하나뿐이다
//   (lib/weekResultFinalizeCore.ts). `클럽 활동 검수(공표) 취소`(unpublishCrewWeekResult)가 같은
//   core 를 호출한다 — 되돌리는 범위가 두 경로에서 갈리지 않는다.
export async function revertTeamPartsWeekReview(
  weekId: string,
  scope: StateScope = "operating",
  actor: string | null = null,
  organization?: OrganizationSlug,
): Promise<WeekResultRevertResult> {
  try {
    return await revertWeekResultCore(weekId, scope, actor, organization);
  } catch (e) {
    if (e instanceof WeekResultFinalizeError) throw new WeekDetailWriteError(e.status, e.message);
    throw e;
  }
}
