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

export type OpeningInfoLine = { lineId: string; lineName: string; checked: boolean };
export type OpeningExperienceLine = { type: ExperienceLineType; checked: boolean };
export type OpeningExperienceTeam = {
  teamId: string;
  teamName: string;
  lines: OpeningExperienceLine[];
};
export type OpeningCompetency = { checked: boolean };

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
    weekRangeLabel: string;
    activityStatus: WeekActivityStatus;
    reviewed: boolean;
    // [오픈 확인] 저장 여부(주차×클럽). GET 시 V 표시 복원용.
    openConfirmed: boolean;
  };
  openingConfig: {
    practicalInfo: OpeningInfoLine[];
    practicalExperience: OpeningExperienceTeam[];
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
type SavedConfig = {
  practicalInfo?: Record<string, boolean>;
  practicalExperience?: Record<string, Partial<Record<ExperienceLineType, boolean>>>;
  practicalCompetency?: { checked?: boolean };
};
async function loadSavedConfig(
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

// 실무 정보 라인 카탈로그(순서 정렬). checked 는 호출부에서 저장값으로 병합(기본 unchecked).
async function loadInfoLineCatalog(): Promise<Array<{ lineId: string; lineName: string }>> {
  const { data, error } = await supabaseAdmin
    .from("activity_types")
    .select("id,name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true);
  if (error) {
    console.warn("[team-parts/info/weeks/detail] activity_types read unavailable:", error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
  const orderIdx = (id: string) => {
    const i = INFO_PREFERRED_ORDER.indexOf(id);
    return i < 0 ? INFO_PREFERRED_ORDER.length : i;
  };
  rows.sort((a, b) => orderIdx(a.id) - orderIdx(b.id) || a.id.localeCompare(b.id));
  return rows.map((r) => ({ lineId: r.id, lineName: r.name ?? r.id }));
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

  const [{ config: saved, openConfirmed }, reviewed, isExpansionWeek, infoCatalog, teams] =
    await Promise.all([
      loadSavedConfig(weekId, organization),
      loadReviewed(weekId),
      loadIsExpansionWeek(organization, managedRow.week_start_date, managedRow.week_end_date),
      loadInfoLineCatalog(),
      listTeams(organization, mode),
    ]);

  // 실무 정보: 기본 unchecked, 저장값이 있으면 덮어씀.
  const savedInfo = saved?.practicalInfo ?? {};
  const practicalInfo: OpeningInfoLine[] = infoCatalog.map((l) => ({
    lineId: l.lineId,
    lineName: l.lineName,
    checked: savedInfo[l.lineId] === true,
  }));

  const savedExp = saved?.practicalExperience ?? {};
  const practicalExperience: OpeningExperienceTeam[] = teams.map((t) => {
    const savedTeam = savedExp[t.id] ?? {};
    return {
      teamId: t.id,
      teamName: t.teamName,
      lines: EXPERIENCE_LINE_TYPES.map((type) => {
        // 기본값: 도출·분석·견문·관리 = true, 확장 = isExpansionWeek.
        const def = type === "expansion" ? isExpansionWeek : true;
        const savedVal = savedTeam[type];
        return { type, checked: typeof savedVal === "boolean" ? savedVal : def };
      }),
    };
  });

  const practicalCompetency: OpeningCompetency = {
    // 기본값: 항상 checked.
    checked:
      typeof saved?.practicalCompetency?.checked === "boolean"
        ? saved.practicalCompetency.checked
        : true,
  };

  const todayIso = today ?? getCurrentActivityDateIso();

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
      weekRangeLabel: weekRangeLabel(managedRow),
      activityStatus: activityStatusOf(managedRow),
      reviewed,
      openConfirmed,
    },
    openingConfig: { practicalInfo, practicalExperience, practicalCompetency },
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

  return out;
}

// [오픈 확인] — 체크 상태를 주차×클럽 오픈 설정으로 저장하고 open_confirmed=true. review 와 무관.
//   snapshot 무접촉(cluster4_week_opening_configs 만 write).
export async function saveWeekOpenConfirm(opts: {
  weekId: string;
  organization: OrganizationSlug;
  config: unknown;
  actorId?: string | null;
}): Promise<{ openConfirmed: true }> {
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
  const { error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .upsert(
      {
        week_id: weekId,
        organization_slug: organization,
        config: normalized as unknown as Record<string, unknown>,
        open_confirmed: true,
        open_confirmed_at: new Date().toISOString(),
        open_confirmed_by: actorId ?? null,
      },
      { onConflict: "week_id,organization_slug" },
    );
  if (error) {
    // 테이블 미적용(마이그레이션 필요) 등.
    throw new WeekDetailWriteError(500, `오픈 설정 저장 실패: ${error.message}`);
  }
  return { openConfirmed: true };
}

// [주차 검수] — weeks.result_reviewed_at 세팅(publish 개념·전 서비스 반영 가능 상태 확정).
//   새 데이터 계산/ snapshot 재계산 없음. 이미 검수된 주차는 최초 검수 시각 유지(idempotent).
export async function markTeamPartsWeekReviewed(
  weekId: string,
): Promise<{ reviewed: true }> {
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id,result_reviewed_at")
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekDetailWriteError(500, wkErr.message);
  if (!wk) throw new WeekDetailWriteError(404, "주차를 찾을 수 없습니다.");

  const row = wk as { result_reviewed_at: string | null };
  if (row.result_reviewed_at != null) return { reviewed: true }; // 이미 검수됨(멱등).

  const { error } = await supabaseAdmin
    .from("weeks")
    .update({ result_reviewed_at: new Date().toISOString() })
    .eq("id", weekId)
    .is("result_reviewed_at", null);
  if (error) throw new WeekDetailWriteError(500, `주차 검수 저장 실패: ${error.message}`);
  return { reviewed: true };
}
