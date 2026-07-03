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
  publishWeekResult,
  markWeekResultReviewed,
  recomputeCohortSnapshots,
  WeekResultPublishError,
  WeekResultReviewError,
} from "@/lib/adminWeekRecognitionsData";
import { revertWeeklyCardFinalization } from "@/lib/adminWeeklyCardFinalizationData";
import type { StateScope } from "@/lib/operationalState";

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
export type SavedConfig = {
  practicalInfo?: Record<string, boolean>;
  practicalExperience?: Record<string, Partial<Record<ExperienceLineType, boolean>>>;
  practicalCompetency?: { checked?: boolean };
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
      loadWeekOpeningConfig(weekId, organization),
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
};

// [검수 완료] — 이 주차의 결과를 "최종 확정"한다(액트 체크/라인 개설 검토 후 크루 결과 반영).
//
//   weekly-card-finalization 과 동일 개념·동일 단일 SoT 를 재사용한다(새 기준/새 데이터 없음):
//     1) 공표(publish)      = weeks.result_published_at (미공표면 publishWeekResult, 이미 공표면 멱등)
//                             → 크루 주차 카드가 tallying(집계 중) → user_week_statuses.status 기준
//                               success(성장 성공)/fail(성장 실패)로 전환된다.
//     2) 코호트 재계산       = recomputeCohortSnapshots (그 주차 uws 보유자 전원 카드 즉시 재계산)
//                             → snapshot-only 조회 구조에서 크루 카드가 즉시 최신 결과를 반영.
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
): Promise<TeamPartsWeekReviewResult> {
  // 0) 주차 존재 + 현재 공표/검수 상태.
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,result_published_at,result_reviewed_at")
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekDetailWriteError(500, wkErr.message);
  if (!wk) throw new WeekDetailWriteError(404, "주차를 찾을 수 없습니다.");
  const week = wk as {
    id: string;
    start_date: string | null;
    result_published_at: string | null;
    result_reviewed_at: string | null;
  };

  // 1) 공표(publish) + 코호트 재계산.
  const alreadyPublished = week.result_published_at != null;
  let publishedAt = week.result_published_at;
  let snapshotRecompute = { requested: 0, recomputed: 0, failed: 0 };
  if (!alreadyPublished) {
    try {
      const r = await publishWeekResult(weekId, "operating", actor);
      publishedAt = r.result_published_at;
      if (r.snapshot_recompute) snapshotRecompute = r.snapshot_recompute;
    } catch (e) {
      if (e instanceof WeekResultPublishError) {
        // 409 = 그 사이 다른 요청이 공표함(race) → 멱등하게 재계산으로 진행.
        if (e.status === 409) {
          snapshotRecompute = await recomputeCohortSnapshots(week.start_date, "operating");
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
  }
  // 이미 공표된 주차는 코호트 재계산을 하지 않는다: 공표 시점(publishWeekResult)에 이미 재계산됐고,
  //   성장 성공/실패 SoT(user_week_statuses)는 검수로 바뀌지 않으므로 크루 카드가 달라질 게 없다.
  //   (재클릭 = 검수 완료 여부만 멱등 보정.) → 대규모 코호트 재클릭 시 불필요한 재계산 방지.

  // 2) 검수 완료(reviewed) — 공표 선행 완료 상태에서 result_reviewed_at 세팅.
  const alreadyReviewed = week.result_reviewed_at != null;
  let reviewedAt = week.result_reviewed_at;
  if (!alreadyReviewed) {
    try {
      const rev = await markWeekResultReviewed(weekId, "operating", actor);
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
): Promise<{ weekId: string; reverted: boolean; publishedAt: string | null; reviewedAt: string | null; snapshotRecompute: { requested: number; recomputed: number; failed: number } }> {
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

  // 공용 rollback 로직 재사용(집계 확정 역연산과 동일 SoT·코호트·재계산).
  const r = await revertWeeklyCardFinalization({
    seasonKey: w.season_key,
    weekNumber: w.week_number,
    org: null,
    scope,
    actor,
  });
  return {
    weekId,
    reverted: r.reverted,
    publishedAt: r.published?.resultPublishedAt ?? null,
    reviewedAt: null,
    snapshotRecompute: r.snapshotRecompute,
  };
}
