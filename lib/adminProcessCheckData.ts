// Server-only data layer for 프로세스 체크 (/admin/processes/check/{hub}) — 체크 동작 Phase.
//
// 마스터(process_line_groups · process_acts) 읽기 + process_check_statuses/process_check_logs
// (org×hub×week×act 체크 상태/이력) 읽기·쓰기. 기존 SoT(cluster4_lines · user_weekly_points ·
// snapshot 경로 · checkGate)는 일절 참조/수정하지 않는다. weeks 는 현재 주차 lookup(읽기)만.
// 포인트 부여/크롤링(완료 트리거)은 본 Phase 범위 밖.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import {
  PROCESS_ACT_TYPE_LABEL,
  PROCESS_CAFE_LABEL,
  PROCESS_HUB_LABEL,
  enforcePointC,
  formatProcessWhen,
  isProcessPoint,
  type ProcessActType,
  type ProcessCafe,
  type ProcessHub,
  type ProcessWeekRef,
} from "@/lib/adminProcessesTypes";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import { classLabel } from "@/lib/adminMembersTypes";
import { accrueForCompletedRegular } from "@/lib/processPointAccrual";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import {
  resolveCluster4TestOpenableWeekStartMs,
  type Cluster4TestWeekHub,
} from "@/lib/cluster4TestWeekPolicy";
import {
  getActiveProcessCheckExceptionWeekIds,
  hasActiveProcessCheckException,
} from "@/lib/processCheckWindowsData";
import { isUuid } from "@/lib/isUuid";
import { filterTeamsByScope, isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { listTeamParts, listPartCrews, listTeamCrews } from "@/lib/adminExperiencePartInput";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  processCheckLogPeriodLabel,
  processCheckPeriodLabel,
  processWeekStatusLabel,
  validateReviewLink,
  validateScheduledCheckAt,
  isPartLineGroupName,
  deriveReviewerResolutionStatus,
  type ProcessCheckReviewerDebug,
  TEAM_OVERALL_LABEL,
  type ProcessCheckAction,
  type ProcessCheckActRowDto,
  type ProcessCheckCrewDto,
  type ProcessCheckBoardDto,
  type ProcessCheckLineGroupDto,
  type ProcessCheckLogAction,
  type ProcessCheckLogDto,
  isTeamBasedProcessHub,
  type ProcessCheckScopeKind,
  isProcessCheckScopeKind,
  isCheckableScope,
  type ProcessCheckStatus,
  type ProcessCheckSummary,
  type ProcessCheckTeamDto,
  type ProcessCheckWeekDto,
  type ProcessWeekOptionDto,
} from "@/lib/adminProcessCheckTypes";

// org 팀 동적 조회(cluster4_teams) — 팀명 하드코딩 금지. listTeams(adminExperienceLineData)와 동일 원천.
// 팀 스코프(operating=운영 팀만 / test=(T) 테스트 팀만)는 filterTeamsByScope 단일 helper 로 적용.
async function loadProcessCheckTeams(
  organization: string,
  mode: ScopeMode = "operating",
): Promise<ProcessCheckTeamDto[]> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_teams")
    .select("id,team_name")
    .eq("organization_slug", organization)
    .eq("is_active", true)
    .order("team_name", { ascending: true });
  if (error) {
    console.warn("[process-check-teams] read unavailable:", error.message);
    return [];
  }
  const teams = ((data ?? []) as Array<{ id: string; team_name: string }>).map((t) => ({
    teamId: t.id,
    teamName: t.team_name,
    // 팀 산하 체크대상 전부 completed → 완료. 본 Phase(섹션.0·팀 스코프 상태 미저장)는 항상 체크 중.
    isAllCompleted: false,
  }));
  return filterTeamsByScope(teams, organization, mode);
}

function migrationHint(error: { code?: string } | null): ProcessMasterError | null {
  const code = error?.code;
  if (code === "PGRST205" || code === "PGRST204") {
    return new ProcessMasterError(
      500,
      "process_check_statuses/process_check_logs 스키마(v2)가 없습니다. db/migrations/2026-06-12_process_check_v2.sql 을 SQL Editor 에서 적용해주세요.",
    );
  }
  return null;
}

// part_name 컬럼 없음(v4 미적용) 식별 — 컬럼 미정의/스키마 캐시 미반영 코드.
function isPartColumnMissing(error: { code?: string } | null): boolean {
  const code = error?.code;
  return code === "42703" || code === "PGRST204" || code === "PGRST205";
}

// process_check_logs.action CHECK 제약 위반(23514 + action 제약명) — 신규 액션값 미확장 신호.
//   check_rolled_back 이 구 CHECK(3값) 에 걸릴 때 check_cancelled 폴백 판정에 쓴다.
function isActionCheckConstraint(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "23514" && /action/i.test(error?.message ?? "");
}

// v4(part_name) 적용 여부 — true 만 캐시(적용 후 영구). 미적용이면 매번 재탐(저렴·degraded 일시).
//   미적용 시: 파트별 독립 불가 → 파트 write 는 fail-closed, read 는 파트 미구분(공유)로 degrade.
let _partColAvailable = false;
async function partNameColumnAvailable(): Promise<boolean> {
  if (_partColAvailable) return true;
  const { error } = await supabaseAdmin.from("process_check_statuses").select("part_name").limit(1);
  if (!error) {
    _partColAvailable = true;
    return true;
  }
  if (isPartColumnMissing(error)) return false;
  // 다른 에러(권한 등)면 일단 있다고 보고 진행(실제 쿼리에서 표면화).
  return true;
}

const PART_MIGRATION_HINT =
  "파트별 체크는 part_name 컬럼(v4)이 필요합니다. db/migrations/2026-06-15_process_check_v4_part_scope.sql 을 SQL Editor 에서 적용해주세요.";

// completion_type/manual_point_* 컬럼(수동 부여) 적용 여부 — true 만 캐시(적용 후 영구).
//   미적용이면 read 는 completion 미구분(degrade), 수동 부여 write 는 fail-closed(아래 힌트).
let _completionColAvailable = false;
async function completionColumnsAvailable(): Promise<boolean> {
  if (_completionColAvailable) return true;
  const { error } = await supabaseAdmin.from("process_check_statuses").select("completion_type").limit(1);
  if (!error) {
    _completionColAvailable = true;
    return true;
  }
  if (isPartColumnMissing(error)) return false;
  return true; // 다른 에러면 있다고 보고 진행(실제 쿼리에서 표면화).
}

const MANUAL_GRANT_MIGRATION_HINT =
  "선별 액트 수동 부여는 completion_type/manual_point_* 컬럼이 필요합니다. db/migrations/2026-06-18_process_check_manual_grant.sql 을 SQL Editor 에서 적용해주세요.";

// 선택 팀의 팀명 조회(org·active 검증). 없으면 null.
async function resolveTeamName(teamId: string, organization: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_teams")
    .select("team_name")
    .eq("id", teamId)
    .eq("organization_slug", organization)
    .eq("is_active", true)
    .maybeSingle();
  if (error) return null;
  return (data as { team_name: string } | null)?.team_name ?? null;
}

// ── 현재 주차 (이번 주 N — 월~일) + weeks.id ─────────────────────────────────

// 프로세스 체크 허브 → 공통 테스트 예외 hub 키 매핑(허용되는 허브만 등재).
//   club·info·experience·competency·career 5종 전부 매핑 = 테스트 W13 예외 허용(운영은 불변).
//   (2026-06-17: competency·career 에 이어 club(클럽 총괄)도 experience/irregular 와 동일 정책으로 허용.)
//   변동 액트는 별도로 "process-irregular" 를 직접 전달한다(resolveProcessWeek).
//   ⚠ 허용 정책 자체(전 조직 등)는 cluster4TestWeekPolicy.TEST_WEEK_HUB_POLICY 단일 출처.
const PROCESS_HUB_TO_TEST_WEEK_HUB: Partial<
  Record<ProcessHub, Cluster4TestWeekHub>
> = {
  club: "process-club",
  info: "process-info",
  experience: "process-experience",
  competency: "process-competency",
  career: "process-career",
};

// 보드 기준 주차(시작 ms) 결정 — 공통 SoT(resolveCluster4TestOpenableWeekStartMs)에 위임.
//   운영 모드 / 예외 미허용 hub → 실제 현재 주차 N(기존 정책 유지).
//   테스트 모드 + 허용 hub → 현재 주차가 휴식 주차여도 마지막 활동 주차(2026-봄 W13)로 폴드.
export function resolveProcessWeekStartMs(
  mode: ScopeMode,
  hub: Cluster4TestWeekHub | null,
): number | null {
  const todayIso = getCurrentActivityDateIso();
  const curMs = getCurrentWeekStartMs(todayIso);
  if (curMs == null) return null;
  if (hub == null) return curMs; // 예외 미허용 허브 → 현재 주차.
  return resolveCluster4TestOpenableWeekStartMs(mode, curMs, {
    hub,
    organization: null,
  });
}

// 주차 DTO 빌더(weeks.id lookup + 라벨) — 허브 무관 공용. 변동 액트도 이 SoT 를 재사용.
export async function resolveProcessWeek(
  mode: ScopeMode,
  hub: Cluster4TestWeekHub | null,
): Promise<ProcessCheckWeekDto | null> {
  const ms = resolveProcessWeekStartMs(mode, hub);
  if (ms == null) return null;
  const d = describeWeekByStartMs(ms);
  if (!d) return null;

  const { data: weekRow } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("iso_year", d.isoYear)
    .eq("iso_week", d.isoWeek)
    .maybeSingle();

  const base = { year: d.year, seasonName: d.seasonName, weekNumber: d.weekNumber };
  return {
    weekId: (weekRow as { id: string } | null)?.id ?? null,
    weekName: `${d.weekNumber}주차`,
    editable: Boolean((weekRow as { id: string } | null)?.id),
    year: d.year,
    seasonName: d.seasonName,
    weekNumber: d.weekNumber,
    startDate: d.weekStart,
    endDate: d.weekEnd,
    periodLabel: processCheckPeriodLabel(base),
    logPeriodLabel: processCheckLogPeriodLabel(base),
  };
}

// 허브 기준 현재 주차(기존 호출부 유지) — ProcessHub → 공통 테스트 예외 hub 키로 매핑해 위임.
function resolveCurrentWeek(hub: ProcessHub, mode: ScopeMode): Promise<ProcessCheckWeekDto | null> {
  return resolveProcessWeek(mode, PROCESS_HUB_TO_TEST_WEEK_HUB[hub] ?? null);
}

// ── 주차 선택 목록(현재 시즌 W1~현재주차) — 프로세스 체크/변동 액트 공용 SoT ───────────
//   미래 주차는 포함하지 않는다(현재 주차가 목록 끝=기본 선택). 테스트 모드는 기존 W13 폴드 정책 유지.
//   각 주차의 weeks.id 는 (iso_year, iso_week) 로 일괄 lookup(없으면 null → 조회는 빈 보드).
//   editable = 현재 주차일 때만 true(과거 주차 = 조회 전용).
const SELECTABLE_WEEK_DAY_MS = 86_400_000;
function weekStartIsoToMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}
export async function resolveSelectableProcessWeeks(
  mode: ScopeMode,
  hub: Cluster4TestWeekHub | null,
  // 활성 예외 주차(process_check_windows) — 기본 목록(현재 시즌 W1~현재) 밖이어도 옵션에 추가하고
  //   편집 가능으로 연다. 예외는 기본 정책을 대체하지 않고 "추가 허용"(비어 있으면 기존 동작 불변).
  exceptionWeekIds: Set<string> = new Set(),
): Promise<{
  options: ProcessWeekOptionDto[];
  currentWeekId: string | null;
  selectedWeekDtoByMs: Map<number, ProcessCheckWeekDto>;
}> {
  const empty = { options: [], currentWeekId: null, selectedWeekDtoByMs: new Map<number, ProcessCheckWeekDto>() };
  const currentMs = resolveProcessWeekStartMs(mode, hub);
  if (currentMs == null) return empty;
  const curDesc = describeWeekByStartMs(currentMs);
  if (!curDesc) return empty;

  // 현재 시즌 1주차 시작 = 현재 주차 시작 − (현재 주차번호 − 1)주.
  const seasonStartMs = currentMs - (curDesc.weekNumber - 1) * 7 * SELECTABLE_WEEK_DAY_MS;
  const descs: Array<{ ms: number; d: ReturnType<typeof describeWeekByStartMs> }> = [];
  for (let i = 0; i < curDesc.weekNumber; i++) {
    const ms = seasonStartMs + i * 7 * SELECTABLE_WEEK_DAY_MS;
    descs.push({ ms, d: describeWeekByStartMs(ms) });
  }

  // weeks.id 일괄 lookup — 등장하는 iso_year/iso_week 범위로 조회 후 (year,week) 정확 매칭.
  const isoYears = Array.from(new Set(descs.map((x) => x.d?.isoYear).filter((x): x is number => x != null)));
  const isoWeeks = Array.from(new Set(descs.map((x) => x.d?.isoWeek).filter((x): x is number => x != null)));
  const weekIdByKey = new Map<string, string>();
  if (isoYears.length && isoWeeks.length) {
    const { data } = await supabaseAdmin
      .from("weeks")
      .select("id,iso_year,iso_week")
      .in("iso_year", isoYears)
      .in("iso_week", isoWeeks);
    for (const w of (data ?? []) as Array<{ id: string; iso_year: number; iso_week: number }>) {
      weekIdByKey.set(`${w.iso_year}-${w.iso_week}`, w.id);
    }
  }
  const currentWeekId = weekIdByKey.get(`${curDesc.isoYear}-${curDesc.isoWeek}`) ?? null;

  // 통합 엔트리(ms 로 유일화) — 기본 정책(W1~현재) + 예외 주차(범위 밖 미래/타시즌).
  type Entry = { ms: number; d: ReturnType<typeof describeWeekByStartMs>; weekId: string | null };
  const byMs = new Map<number, Entry>();
  for (const { ms, d } of descs) {
    if (!d) continue;
    byMs.set(ms, { ms, d, weekId: weekIdByKey.get(`${d.isoYear}-${d.isoWeek}`) ?? null });
  }

  // 예외 주차 중 기본 목록에 없는 것(미래/타시즌)을 추가로 붙인다(week_id → weeks 행 조회).
  const coveredWeekIds = new Set(
    Array.from(byMs.values()).map((e) => e.weekId).filter((x): x is string => Boolean(x)),
  );
  const extraIds = Array.from(exceptionWeekIds).filter((id) => isUuid(id) && !coveredWeekIds.has(id));
  if (extraIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date")
      .in("id", extraIds);
    for (const w of (data ?? []) as Array<{ id: string; start_date: string }>) {
      const ms = weekStartIsoToMs(w.start_date);
      const d = describeWeekByStartMs(ms);
      if (!d) continue;
      const existing = byMs.get(ms);
      if (existing) existing.weekId = w.id;
      else byMs.set(ms, { ms, d, weekId: w.id });
    }
  }

  // 최신(시작일 큰) 주차가 위로 — 미래 예외 → 현재 → 과거.
  const entries = Array.from(byMs.values()).sort((a, b) => b.ms - a.ms);
  const selectedWeekDtoByMs = new Map<number, ProcessCheckWeekDto>();
  const options: ProcessWeekOptionDto[] = [];
  for (const { ms, d, weekId } of entries) {
    if (!d) continue;
    const isCurrent = ms === currentMs;
    const isException = Boolean(weekId) && exceptionWeekIds.has(weekId as string);
    const base = { year: d.year, seasonName: d.seasonName, weekNumber: d.weekNumber };
    options.push({
      weekId,
      weekNumber: d.weekNumber,
      weekName: `${d.weekNumber}주차`,
      // 드롭다운 표기 = 연도+시즌+주차(공용 SoT). "26년 봄 시즌 17주차".
      periodLabel: processCheckLogPeriodLabel(base),
      startDate: d.weekStart,
      endDate: d.weekEnd,
      isOfficialRest: d.isOfficialRest,
      statusLabel: processWeekStatusLabel(d.isOfficialRest),
      isCurrent,
    });
    selectedWeekDtoByMs.set(ms, {
      weekId,
      weekName: `${d.weekNumber}주차`,
      // 현재 주차 또는 활성 예외 주차만 편집 가능(그 외 과거 = 조회 전용).
      editable: (isCurrent || isException) && Boolean(weekId),
      year: d.year,
      seasonName: d.seasonName,
      weekNumber: d.weekNumber,
      startDate: d.weekStart,
      endDate: d.weekEnd,
      periodLabel: processCheckPeriodLabel(base),
      logPeriodLabel: processCheckLogPeriodLabel(base),
    });
  }
  return { options, currentWeekId, selectedWeekDtoByMs };
}

// 보드 조회용 — 선택 주차(weekId) 해석 + 주차 목록/현재주차/편집가능 동시 반환.
//   selectedWeekId 가 목록 밖(미래/타시즌/형식오류)이면 현재 주차로 폴백. week DTO 는 선택 주차 기준.
async function resolveBoardWeek(
  hub: ProcessHub,
  mode: ScopeMode,
  selectedWeekId: string | null | undefined,
  // 활성 예외 주차(process_check_windows · org+hub 스코프). 기본 목록 밖 예외 주차도 선택·편집 가능.
  exceptionWeekIds: Set<string> = new Set(),
): Promise<{
  week: ProcessCheckWeekDto | null;
  weeks: ProcessWeekOptionDto[];
  selectedWeekId: string | null;
  effectiveWeekId: string | null;
  editable: boolean;
}> {
  const hubKey = PROCESS_HUB_TO_TEST_WEEK_HUB[hub] ?? null;
  const { options, currentWeekId, selectedWeekDtoByMs } = await resolveSelectableProcessWeeks(
    mode,
    hubKey,
    exceptionWeekIds,
  );

  const validIds = new Set(options.map((o) => o.weekId).filter((x): x is string => Boolean(x)));
  const effectiveWeekId = selectedWeekId && validIds.has(selectedWeekId) ? selectedWeekId : currentWeekId;

  let week: ProcessCheckWeekDto | null = null;
  for (const dto of selectedWeekDtoByMs.values()) {
    if (dto.weekId && dto.weekId === effectiveWeekId) {
      week = dto;
      break;
    }
  }
  if (!week) week = await resolveCurrentWeek(hub, mode); // weeks 행 없음 등 폴백(라벨만).

  // 편집 가능 = 현재 주차이거나 활성 예외 주차(추가 허용).
  const editable =
    Boolean(effectiveWeekId) &&
    (effectiveWeekId === currentWeekId ||
      (Boolean(effectiveWeekId) && exceptionWeekIds.has(effectiveWeekId as string)));
  return { week, weeks: options, selectedWeekId: effectiveWeekId, effectiveWeekId, editable };
}

// weeks.id 로 직접 주차 DTO 해석 — write 경로가 선택(예외) 주차에 저장할 때 라벨/기간 산출용.
export async function resolveProcessWeekByWeekId(weekId: string): Promise<ProcessCheckWeekDto | null> {
  if (!isUuid(weekId)) return null;
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date")
    .eq("id", weekId)
    .maybeSingle();
  const row = data as { id: string; start_date: string } | null;
  if (!row) return null;
  const d = describeWeekByStartMs(weekStartIsoToMs(row.start_date));
  if (!d) return null;
  const base = { year: d.year, seasonName: d.seasonName, weekNumber: d.weekNumber };
  return {
    weekId: row.id,
    weekName: `${d.weekNumber}주차`,
    editable: true,
    year: d.year,
    seasonName: d.seasonName,
    weekNumber: d.weekNumber,
    startDate: d.weekStart,
    endDate: d.weekEnd,
    periodLabel: processCheckPeriodLabel(base),
    logPeriodLabel: processCheckLogPeriodLabel(base),
  };
}

// write 대상 주차 결정 — 기본=현재 주차. 선택 주차가 현재와 다르면 활성 예외(org+hub)일 때만 허용.
//   예외가 아니면 fail-closed(422) — 조회는 과거 주차를 보여줘도 저장은 예외/현재 주차로만 강제.
async function resolveWriteWeek(
  hub: ProcessHub,
  mode: ScopeMode,
  organization: string,
  requestedWeekId: string | null | undefined,
): Promise<ProcessCheckWeekDto | null> {
  const currentWeek = await resolveCurrentWeek(hub, mode);
  const requested =
    typeof requestedWeekId === "string" && requestedWeekId.trim() ? requestedWeekId.trim() : null;
  if (!requested || requested === currentWeek?.weekId) return currentWeek;
  const allowed = await hasActiveProcessCheckException(requested, organization, hub);
  if (!allowed) {
    throw new ProcessMasterError(422, "선택한 주차는 편집할 수 없습니다(예외 허용 주차가 아닙니다)");
  }
  const exWeek = await resolveProcessWeekByWeekId(requested);
  if (!exWeek?.weekId) {
    throw new ProcessMasterError(400, "예외 주차(weeks 행)를 찾을 수 없습니다");
  }
  return exWeek;
}

// ── 마스터(활성) 읽기 ─────────────────────────────────────────────────────────
type LineGroupRow = { id: string; name: string; sort_order: number };
type ActRow = {
  id: string;
  line_group_id: string;
  act_name: string;
  check_target: string;
  duration_minutes: number;
  occur_week: string;
  occur_dow: number;
  occur_time: string;
  check_week: string;
  check_dow: number;
  check_time: string;
  point_check: number;
  point_advantage: number;
  point_penalty: number;
  act_type: string;
  cafe: string;
  created_at: string;
};

async function loadActiveMaster(hub: ProcessHub): Promise<{ groups: LineGroupRow[]; acts: ActRow[] }> {
  const [{ data: groupData, error: gErr }, { data: actData, error: aErr }] = await Promise.all([
    supabaseAdmin
      .from("process_line_groups")
      .select("id,name,sort_order")
      .eq("hub", hub)
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("process_acts")
      .select(
        "id,line_group_id,act_name,check_target,duration_minutes,occur_week,occur_dow,occur_time,check_week,check_dow,check_time,point_check,point_advantage,point_penalty,act_type,cafe,created_at",
      )
      .eq("hub", hub)
      .eq("is_active", true)
      .order("created_at", { ascending: true }),
  ]);
  if (gErr) throw migrationHint(gErr) ?? new ProcessMasterError(500, gErr.message);
  if (aErr) throw migrationHint(aErr) ?? new ProcessMasterError(500, aErr.message);
  return {
    groups: (groupData ?? []) as unknown as LineGroupRow[],
    acts: (actData ?? []) as unknown as ActRow[],
  };
}

// ── 체크 상태 읽기 (org × hub × week) — best-effort(테이블 미적용 시 빈 맵 = 전부 needed) ──
type StatusRow = {
  id: string;
  act_id: string;
  status: string;
  review_link: string | null;
  scheduled_check_at: string | null;
  requested_at: string | null;
  completed_at: string | null;
  checked_crew_count: number | null;
  attempt_count: number | null;
  last_error: string | null;
  completion_type?: string | null; // 수동 부여 컬럼(미적용이면 미선택 → undefined)
};
type StatusState = {
  statusRowId: string | null; // recipients(ref_id) 조인 키. needed(행 없음)면 null.
  status: ProcessCheckStatus;
  completionType: "manual_grant" | null; // 완료 경로 — 수동 부여면 "수동 부여 완료" 라벨.
  reviewLink: string | null;
  scheduledCheckAt: string | null;
  requestedAt: string | null;
  completedAt: string | null;
  checkedCrewCount: number | null;
  attemptCount: number;
  lastError: string | null;
};
const STATUS_SELECT_BASE =
  "id,act_id,status,review_link,scheduled_check_at,requested_at,completed_at,checked_crew_count,attempt_count,last_error";
// completion 컬럼 적용 시에만 추가(미적용 보드는 BASE 만으로 동작 — degrade).
const STATUS_SELECT_FULL = `${STATUS_SELECT_BASE},completion_type`;

function toStatusState(r: StatusRow): StatusState {
  const status: ProcessCheckStatus =
    r.status === "pending" || r.status === "completed" ? r.status : "needed";
  return {
    statusRowId: r.id,
    status,
    completionType: r.completion_type === "manual_grant" ? "manual_grant" : null,
    reviewLink: r.review_link,
    scheduledCheckAt: r.scheduled_check_at,
    requestedAt: r.requested_at,
    completedAt: r.completed_at,
    checkedCrewCount: r.checked_crew_count,
    attemptCount: r.attempt_count ?? 0,
    lastError: r.last_error ?? null,
  };
}

// ── 크루 메타(이름·팀·파트·클래스) 일괄 해소 — 체크 완료 명단/수동 부여 공용 ────────
//   user_profiles(display_name·role) + user_memberships(team_name·part_name·membership_level).
//   className = classLabel(role, level) 단일 SoT(/admin/members 클래스 컬럼과 동일).
type CrewMeta = { name: string; teamName: string | null; partName: string | null; className: string };
async function resolveCrewMeta(userIds: string[]): Promise<Map<string, CrewMeta>> {
  const map = new Map<string, CrewMeta>();
  const ids = Array.from(new Set(userIds.filter((x): x is string => Boolean(x))));
  if (ids.length === 0) return map;
  const [{ data: profs }, { data: mems }] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,role,current_team_name,current_part_name")
      .in("user_id", ids),
    supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,is_current")
      .in("user_id", ids),
  ]);
  type MemRow = {
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    is_current: boolean | null;
  };
  const memMap = new Map<string, MemRow>();
  for (const m of (mems ?? []) as MemRow[]) {
    const ex = memMap.get(m.user_id);
    if (!ex || (m.is_current && !ex.is_current)) memMap.set(m.user_id, m);
  }
  // 첫 비어있지 않은 값. 팀장 등 user_memberships 행이 없는 운영진은 team/part 가 전부 null 이 되어
  // 명단에 팀이 "-" 로 빠지므로, 비정규화된 user_profiles.current_* 로 폴백한다(adminCrewData 의
  // membership → profile.current_* 폴백 규칙과 동일 — 고객앱 resolver 규칙 5).
  const pick = (...vals: Array<string | null | undefined>): string | null => {
    for (const v of vals) if (v && v.trim()) return v;
    return null;
  };
  for (const p of (profs ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    role: string | null;
    current_team_name: string | null;
    current_part_name: string | null;
  }>) {
    const m = memMap.get(p.user_id);
    map.set(p.user_id, {
      name: p.display_name?.trim() || "(이름 없음)",
      teamName: pick(m?.team_name, p.current_team_name),
      partName: pick(m?.part_name, p.current_part_name),
      className: classLabel(p.role ?? null, m?.membership_level ?? null),
    });
  }
  return map;
}

// 크루 메타 맵 + (user_id, 닉네임 폴백) → 명단 행. user_id 미해소면 닉네임만(나머지 null/"-").
function toCrewDto(
  meta: Map<string, CrewMeta>,
  userId: string | null,
  nickname: string | null,
): ProcessCheckCrewDto {
  const m = userId ? meta.get(userId) : undefined;
  return {
    userId,
    name: m?.name ?? (nickname?.trim() || "(이름 없음)"),
    teamName: m?.teamName ?? null,
    partName: m?.partName ?? null,
    className: m?.className ?? "-",
  };
}

// ── 검수 크루 식별 결과(recipients) 조인 — 진단(reviewerDebug) + 체크 완료 명단 산출용 ──
//   process_check_review_recipients(source='regular', ref_id=status row id). best-effort
//   (테이블/컬럼 미적용이면 빈 맵 → reviewerDebug 는 status 기반 파생만·명단은 빈 배열).
//   agg      = ref_id 별 매칭/미매칭 집계(reviewerDebug 용).
//   crewLists = ref_id 별 매칭 크루 명단(이름·팀·파트·클래스 — 체크 완료 팝업 명단).
type RecipientAgg = { matched: number; unmatchedAuthors: string[] };
type RecipientData = {
  agg: Map<string, RecipientAgg>;
  crewLists: Map<string, ProcessCheckCrewDto[]>;
};
async function loadRecipientData(statusRowIds: string[]): Promise<RecipientData> {
  const agg = new Map<string, RecipientAgg>();
  const crewLists = new Map<string, ProcessCheckCrewDto[]>();
  if (statusRowIds.length === 0) return { agg, crewLists };
  const { data, error } = await supabaseAdmin
    .from("process_check_review_recipients")
    .select("ref_id,match_type,nickname,user_id")
    .eq("source", "regular")
    .in("ref_id", statusRowIds);
  if (error) {
    console.warn("[process-check-recipients] read unavailable:", error.message);
    return { agg, crewLists };
  }
  const rows = (data ?? []) as Array<{
    ref_id: string;
    match_type: string;
    nickname: string | null;
    user_id: string | null;
  }>;
  // 매칭 크루(명단 대상) — ref_id 별 보관 + 메타 해소용 user_id 수집.
  const matchedByRef = new Map<string, Array<{ userId: string | null; nickname: string | null }>>();
  const userIds: string[] = [];
  for (const r of rows) {
    let a = agg.get(r.ref_id);
    if (!a) agg.set(r.ref_id, (a = { matched: 0, unmatchedAuthors: [] }));
    if (r.match_type === "matched") {
      a.matched += 1;
      let lst = matchedByRef.get(r.ref_id);
      if (!lst) matchedByRef.set(r.ref_id, (lst = []));
      lst.push({ userId: r.user_id, nickname: r.nickname });
      if (r.user_id) userIds.push(r.user_id);
    } else {
      a.unmatchedAuthors.push(r.nickname ?? "");
    }
  }
  const meta = await resolveCrewMeta(userIds);
  for (const [ref, lst] of matchedByRef) {
    const out = lst.map((x) => toCrewDto(meta, x.userId, x.nickname));
    out.sort((a, b) => a.name.localeCompare(b.name));
    crewLists.set(ref, out);
  }
  return { agg, crewLists };
}

// 액트 행 1건의 검수 크루 진단 산출 — recipients(있으면 우선) + status/last_error 파생.
//   matchedCountOverride: 팀 구분 허브(experience)에서 "카페 매칭 ∩ 선택 팀/파트 실제 소속자"로
//   교집합한 매칭 수(호출부가 로스터로 산출). null 이면 기존 파생(비팀 허브·회귀 금지).
function buildReviewerDebug(
  st: StatusState,
  recipients: Map<string, RecipientAgg>,
  matchedCountOverride: number | null = null,
): ProcessCheckReviewerDebug {
  const rec = st.statusRowId ? recipients.get(st.statusRowId) : undefined;
  // 매칭 수 — 소속 교집합 override 가 있으면 우선, 없으면 recipients matched, 없으면 checked_crew_count 폴백.
  const matchedCount = matchedCountOverride != null ? matchedCountOverride : rec ? rec.matched : st.checkedCrewCount ?? 0;
  const unmatchedCommentAuthors = rec ? rec.unmatchedAuthors : [];
  const reviewCount = unmatchedCommentAuthors.length;
  return {
    resolutionStatus: deriveReviewerResolutionStatus({
      status: st.status,
      lastError: st.lastError,
      matchedCount,
      reviewCount,
    }),
    crawledCommentCount: matchedCount + reviewCount,
    matchedCrewCount: matchedCount,
    unmatchedCommentAuthors,
    attemptCount: st.attemptCount,
    lastError: st.lastError,
  };
}

type StatusRowFull = { actId: string; partName: string | null; state: StatusState };

// (org, hub, week, team) 상태 행 전체 — part_name 포함(v4). 스코프 필터는 호출부(JS)에서.
//   info 등 비팀 허브는 team_id IS NULL(기존). v4 미적용이면 part_name 없이 조회(전부 partName=null).
async function loadStatusRows(
  organization: string,
  hub: ProcessHub,
  weekId: string,
  teamId: string | null,
  partAvail: boolean,
  completionAvail: boolean,
): Promise<StatusRowFull[]> {
  const base = completionAvail ? STATUS_SELECT_FULL : STATUS_SELECT_BASE;
  const sel = partAvail ? `${base},part_name` : base;
  let query = supabaseAdmin
    .from("process_check_statuses")
    .select(sel)
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId);
  if (isTeamBasedProcessHub(hub)) {
    query = teamId ? query.eq("team_id", teamId) : query.is("team_id", null);
  }
  const { data, error } = await query;
  if (error) {
    console.warn("[process-check-statuses] read unavailable:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<StatusRow & { part_name?: string | null }>).map((r) => ({
    actId: r.act_id,
    partName: partAvail ? (r.part_name ?? null) : null,
    state: toStatusState(r),
  }));
}

const NEEDED: StatusState = {
  statusRowId: null,
  status: "needed",
  completionType: null,
  reviewLink: null,
  scheduledCheckAt: null,
  requestedAt: null,
  completedAt: null,
  checkedCrewCount: null,
  attemptCount: 0,
  lastError: null,
};

// ── 보드 조회 ─────────────────────────────────────────────────────────────────
export async function getProcessCheckBoard(
  hub: ProcessHub,
  organization: string,
  // teamId: experience 섹션.1 선택 팀(team_id 스코프). null = 섹션.0/info(team_id IS NULL).
  teamId: string | null = null,
  // 팀 목록 스코프(operating=운영 팀만 / test=(T) 팀만). 기본 operating.
  mode: ScopeMode = "operating",
  // 팀·파트 스코프(experience 섹션.1). null = 비팀/섹션.0. team_all=읽기전용 전체.
  scope: ProcessCheckScopeKind | null = null,
  // 선택 파트명(scope=part). user_memberships 의 실제 파트.
  partName: string | null = null,
  // 드롭다운 선택 주차(weeks.id). 미지정/목록 밖이면 현재 주차로 폴백. 과거 주차 = 조회 전용(editable=false).
  selectedWeekId: string | null = null,
): Promise<ProcessCheckBoardDto> {
  // 활성 예외 주차(process_check_windows · org+hub 스코프) — 기본 정책 밖 주차도 드롭다운/편집 허용.
  const exceptionWeekIds = await getActiveProcessCheckExceptionWeekIds(organization, hub);
  const { week, weeks: weekOptions, selectedWeekId: effSelectedWeekId, effectiveWeekId, editable } =
    await resolveBoardWeek(hub, mode, selectedWeekId, exceptionWeekIds);
  const { groups, acts } = await loadActiveMaster(hub);
  const teamBased = isTeamBasedProcessHub(hub);

  // 팀 구분 허브면 org 팀 동적 조회(상태창1 팀별 문장 + 섹션.1 탭). 그 외는 빈 배열(허브 전체 1문장).
  const teams = teamBased ? await loadProcessCheckTeams(organization, mode) : [];

  // 실제 팀 파트 목록(드롭다운) — user_memberships(part_name) · org+mode 스코프. 팀 선택 시에만.
  const teamName = teamBased && teamId ? await resolveTeamName(teamId, organization) : null;
  const teamParts = teamName ? await listTeamParts(organization, teamName, mode) : [];

  // ── 체크 대상자 로스터(선택 팀/파트 실제 소속자) — 팀 구분 허브(experience)만 산출 ─────────────
  //   체크 완료 명단/매칭 수를 "카페 링크 집계 ∩ 실제 팀/파트 소속자"로 교집합할 때 쓴다(UI 숨김이 아닌
  //   서버 산정 단계 필터). key: 파트명 · "" = 팀 총괄(part_name NULL).
  //   ⚠ 적립(computeDesiredAwards)이 쓰는 resolveCheckScopeRoster 와 동일 원천(loadTeamCrewRows):
  //     rosterByPart.get(part) === listPartCrews(part), rosterByPart.get("") === listTeamCrews.
  //     한 번의 listTeamCrews 로 파트별 로스터까지 파생해(동치) 조회를 줄인다 → 명단·인원·적립이 항상 일치.
  const rosterByPart = new Map<string, Set<string>>();
  if (teamBased && teamId && teamName) {
    const teamCrews = await listTeamCrews(organization, teamName, mode);
    rosterByPart.set("", new Set(teamCrews.map((c) => c.userId)));
    for (const part of teamParts) {
      rosterByPart.set(part, new Set(teamCrews.filter((c) => c.partName === part).map((c) => c.userId)));
    }
  }
  // 이 행(파트 스코프)의 로스터 집합 — 팀 구분 허브만. 비팀/미선택은 null(필터 no-op).
  //   미해소 파트는 빈 집합(fail-closed: 타 팀/타 파트/미소속 전면 제외).
  const rosterForPart = (partForRoster: string | null): Set<string> | null =>
    teamBased && teamId ? rosterByPart.get(partForRoster ?? "") ?? new Set<string>() : null;

  // 유효 스코프 — 팀 선택(experience)일 때만. 기본 team_all. part 인데 partName 이 팀 파트가 아니면 team_all 폴백.
  const partAvail = teamBased && teamId ? await partNameColumnAvailable() : false;
  let effScope: ProcessCheckScopeKind | null = null;
  let effPart: string | null = null;
  if (teamBased && teamId) {
    effScope = scope ?? "team_all";
    if (effScope === "part") {
      effPart = partName && teamParts.includes(partName) ? partName : null;
      if (!effPart) effScope = "team_all"; // 알 수 없는 파트 → 읽기전용 폴백
    }
  }

  // 상태 행 로드 + 스코프별 액트→상태 맵 구성. completion_type(수동 부여)도 함께(적용 시).
  const completionAvail = await completionColumnsAvailable();
  const rows = effectiveWeekId
    ? await loadStatusRows(organization, hub, effectiveWeekId, teamId, partAvail, completionAvail)
    : [];
  // 검수 크루 식별 결과(recipients) 조인 — reviewerDebug + 체크 완료 명단(read-only·best-effort).
  const { agg: recipients, crewLists } = await loadRecipientData(
    rows.map((r) => r.state.statusRowId).filter((x): x is string => Boolean(x)),
  );
  const nullMap = new Map<string, StatusState>(); // part_name IS NULL(팀 총괄/info)
  const perActPerPart = new Map<string, Map<string, StatusState>>(); // 파트 액트(act→part→state)
  for (const r of rows) {
    if (r.partName == null) {
      nullMap.set(r.actId, r.state);
    } else {
      let m = perActPerPart.get(r.actId);
      if (!m) perActPerPart.set(r.actId, (m = new Map()));
      m.set(r.partName, r.state);
    }
  }
  // 스코프별 액트 필터(표시 대상).
  const inScope = (lineGroupName: string): boolean => {
    if (effScope === "team_overall") return !isPartLineGroupName(lineGroupName);
    if (effScope === "part") return isPartLineGroupName(lineGroupName);
    return true; // team_all · 비팀(info)/섹션.0 → 전체
  };

  const groupNameById = new Map<string, string>();
  const groupSort = new Map<string, number>();
  for (const g of groups) {
    groupNameById.set(g.id, g.name);
    groupSort.set(g.id, g.sort_order);
  }

  // [섹션.1] 액트 목록 — 신청 시점(필요) 순: occur_week(N→N+1) → occur_dow(일~토) →
  //   occur_time(빠른 시간) → 라인급 sort_order → act created_at.
  const weekRank = (w: string) => (w === "N" ? 0 : 1);
  const sortedActs = [...acts].sort(
    (a, b) =>
      weekRank(a.occur_week) - weekRank(b.occur_week) ||
      a.occur_dow - b.occur_dow ||
      a.occur_time.localeCompare(b.occur_time) ||
      (groupSort.get(a.line_group_id) ?? 0) - (groupSort.get(b.line_group_id) ?? 0) ||
      a.created_at.localeCompare(b.created_at),
  );
  // 한 액트 + 상태 + 파트라벨 → 행 DTO. (정적 필드 공통)
  //   partForRoster: 이 행의 파트 스코프(파트명 · null=팀 총괄). 팀 구분 허브에서 "체크 완료 명단/매칭 수"를
  //   카페 링크 집계 ∩ 실제 팀/파트 소속자로 교집합하는 데 쓴다(비팀 허브는 roster=null → 필터 no-op).
  const buildRow = (
    a: ActRow,
    lineGroupName: string,
    st: StatusState,
    partLabel: string,
    partForRoster: string | null,
  ): ProcessCheckActRowDto => {
    const roster = rosterForPart(partForRoster);
    // 카페 매칭 명단(상태행 id 로 매핑) — 팀 구분 허브면 실제 소속 로스터로 교집합.
    const rawMatchedList = st.statusRowId ? crewLists.get(st.statusRowId) ?? [] : [];
    const scopedMatchedList = roster
      ? rawMatchedList.filter((c) => c.userId != null && roster.has(c.userId))
      : rawMatchedList;
    const completedCrewList = st.status === "completed" ? scopedMatchedList : [];
    return {
      actId: a.id,
      lineGroupId: a.line_group_id,
      lineGroupName,
      partLabel,
      actName: a.act_name,
      durationMinutes: a.duration_minutes,
      occurWhen: formatProcessWhen(a.occur_week as ProcessWeekRef, a.occur_dow, a.occur_time),
      checkWhen: formatProcessWhen(a.check_week as ProcessWeekRef, a.check_dow, a.check_time),
      pointCheck: a.point_check,
      pointAdvantage: a.point_advantage,
      pointPenalty: a.point_penalty,
      actType: a.act_type as ProcessActType,
      crewReactionLabel: PROCESS_ACT_TYPE_LABEL[a.act_type as ProcessActType] ?? a.act_type,
      cafeLabel: PROCESS_CAFE_LABEL[a.cafe as ProcessCafe] ?? a.cafe,
      isCheckTarget: a.check_target === "check",
      checkStatusId: st.statusRowId,
      status: st.status,
      completionType: st.completionType,
      reviewLink: st.reviewLink,
      scheduledCheckAt: st.scheduledCheckAt,
      requestedAt: st.requestedAt,
      completedAt: st.completedAt,
      // "체크 완료 N명" = 교집합된 명단 크기(팀 구분 허브·completed). 비팀/그 외는 저장값(불변).
      checkedCrewCount:
        roster && st.status === "completed" ? completedCrewList.length : st.checkedCrewCount,
      // 체크 완료 명단 — completed 행만. 팀 구분 허브면 실제 소속자로 교집합된 목록.
      completedCrewList,
      // 매칭 수도 동일 교집합 반영(비팀 허브는 override=null → 기존 파생).
      reviewerDebug: buildReviewerDebug(st, recipients, roster ? scopedMatchedList.length : null),
    };
  };

  // 행 생성 — partLabel("팀 총괄"/파트명) 부여. 팀 전체(team_all)의 파트 액트는 팀 파트마다 1행으로 펼친다
  //   (액트가 특정 파트에 묶이지 않으므로, 각 파트의 독립 상태를 그대로 노출 — "팀 전체"는 값으로 안 씀).
  const flatActs: ProcessCheckActRowDto[] = [];
  for (const a of sortedActs) {
    const lineGroupName = groupNameById.get(a.line_group_id) ?? "-";
    if (!inScope(lineGroupName)) continue;
    const isPart = isPartLineGroupName(lineGroupName);

    if (effScope === "part") {
      // 선택 파트만 — partLabel = 선택 파트명, 상태 = 그 파트 행. 로스터 = 그 파트 소속자.
      flatActs.push(buildRow(a, lineGroupName, perActPerPart.get(a.id)?.get(effPart!) ?? NEEDED, effPart!, effPart));
    } else if (effScope === "team_overall") {
      // 팀 총괄 — 로스터 = 팀 전체 소속자(part=null).
      flatActs.push(buildRow(a, lineGroupName, nullMap.get(a.id) ?? NEEDED, TEAM_OVERALL_LABEL, null));
    } else if (effScope === "team_all" && isPart) {
      // 팀 전체 — 파트 액트는 팀 파트마다 펼침(각 파트 독립 상태·로스터). 파트 없으면 1행(미배정).
      if (teamParts.length === 0) {
        flatActs.push(buildRow(a, lineGroupName, NEEDED, "파트(미배정)", null));
      } else {
        for (const part of teamParts) {
          flatActs.push(buildRow(a, lineGroupName, perActPerPart.get(a.id)?.get(part) ?? NEEDED, part, part));
        }
      }
    } else {
      // team_all 의 총괄 액트 · 비팀(info)/섹션.0 → part_name NULL 행. (info 는 컬럼 미표시·roster=null no-op)
      flatActs.push(buildRow(a, lineGroupName, nullMap.get(a.id) ?? NEEDED, isPart ? "파트" : TEAM_OVERALL_LABEL, null));
    }
  }

  // 라인급 칩 — 체크 대상 ≥1 라인급. 신청완료 = pending|completed.
  const applied = (s: ProcessCheckStatus) => s === "pending" || s === "completed";
  const lineGroups: ProcessCheckLineGroupDto[] = [];
  for (const g of groups) {
    const targets = flatActs.filter((x) => x.lineGroupId === g.id && x.isCheckTarget);
    if (targets.length === 0) continue;
    const appliedCount = targets.filter((x) => applied(x.status)).length;
    lineGroups.push({
      lineGroupId: g.id,
      name: g.name,
      targetActCount: targets.length,
      appliedActCount: appliedCount,
      // 완료 = 산하 체크 대상 전부 신청완료(대상 0개는 완료 아님). 일부 완료(appliedCount>0)는 미완료.
      isCompleted: targets.length > 0 && appliedCount === targets.length,
    });
  }

  const targetActs = flatActs.filter((x) => x.isCheckTarget);
  const actTotal = targetActs.length;
  const actApplied = targetActs.filter((x) => applied(x.status)).length;
  const actCompleted = targetActs.filter((x) => x.status === "completed").length;
  const summary: ProcessCheckSummary = {
    lineGroupTotal: lineGroups.length,
    // "N개 중 M개 체크 신청 완료" — 배지 완료 색상과 동일 기준(산하 체크 대상 전부 신청완료인 라인급 수).
    lineGroupApplied: lineGroups.filter((g) => g.isCompleted).length,
    actTotal,
    actApplied,
    actCompleted,
    isAllCompleted: actTotal > 0 && actCompleted === actTotal,
  };

  const logs = await listProcessCheckLogs(hub, organization, effectiveWeekId);

  // 선택 파트의 체크 대상 크루 수(표시·가드 참고) — scope=part 일 때만.
  let selectedPart: { name: string; crewCount: number } | null = null;
  if (effScope === "part" && effPart && teamName) {
    const crews = await listPartCrews(organization, teamName, effPart, mode);
    selectedPart = { name: effPart, crewCount: crews.length };
  }

  return {
    hub,
    hubLabel: PROCESS_HUB_LABEL[hub],
    organization,
    mode,
    week,
    selectedWeek: week,
    weeks: weekOptions,
    selectedWeekId: effSelectedWeekId,
    editable,
    teams,
    teamParts,
    selectedPart,
    lineGroups,
    acts: flatActs,
    summary,
    logs,
  };
}

// ── 로그 조회 (org × hub × week, 오래된→최신: 위 과거/아래 최신) ───────────────
type LogRow = {
  id: string;
  action: string;
  period_label: string;
  team_name?: string | null; // v3 미적용 fallback select 시 미포함
  part_name?: string | null; // v4 미적용 fallback select 시 미포함
  line_group_name: string;
  act_name: string;
  actor_name: string;
  created_at: string;
};

// 로그창은 섹션.0(전체 팀) — 팀 필터 없이 org×hub×week 전체. 각 행은 team_name/part_name(있으면) 표시.
export async function listProcessCheckLogs(
  hub: ProcessHub,
  organization: string,
  weekId: string | null,
  limit = 200,
): Promise<ProcessCheckLogDto[]> {
  const cap = Math.min(Math.max(limit, 1), 500);
  const BASE = "id,action,period_label,line_group_name,act_name,actor_name,created_at";
  // tier: 2=team_name+part_name(v4) · 1=team_name(v3) · 0=none(v2). 상위 실패(42703)면 하위로.
  const run = (tier: number) => {
    const sel =
      tier >= 2
        ? `id,action,period_label,team_name,part_name,${BASE.slice(BASE.indexOf("line_group_name"))}`
        : tier === 1
          ? `id,action,period_label,team_name,${BASE.slice(BASE.indexOf("line_group_name"))}`
          : BASE;
    let q = supabaseAdmin
      .from("process_check_logs")
      .select(sel)
      .eq("organization_slug", organization)
      .eq("hub", hub)
      .order("created_at", { ascending: false })
      .limit(cap);
    if (weekId) q = q.eq("week_id", weekId);
    return q;
  };
  let { data, error } = await run(2);
  if (error && isPartColumnMissing(error)) ({ data, error } = await run(1)); // v4 미적용
  if (error && isPartColumnMissing(error)) ({ data, error } = await run(0)); // v3 미적용
  if (error) {
    console.warn("[process-check-logs] list unavailable:", error.message);
    return [];
  }
  const rows = ((data ?? []) as unknown as LogRow[]).map((r) => ({
    id: r.id,
    action: r.action as ProcessCheckLogAction,
    periodLabel: r.period_label,
    teamName: r.team_name ?? null, // 팀 구분 허브(experience)만 채워짐 — info 등은 null
    partName: r.part_name ?? null, // 파트 스코프 체크만 채워짐 — 팀 총괄/info 등은 null
    lineGroupName: r.line_group_name,
    actName: r.act_name,
    actorName: r.actor_name,
    createdAt: r.created_at,
  }));
  return rows.reverse(); // 위=과거, 아래=최신
}

// ── 액션 (체크 신청 / 취소) ───────────────────────────────────────────────────
//   request : needed → pending  (review_link + scheduled_check_at, requested_at=now)
//   cancel  : pending → needed   (now < scheduled_check_at 일 때만, 입력값 제거)
//   complete(시스템) 는 본 Phase 미구현 — user_weekly_points/snapshot/크롤링 무접촉.
export async function applyProcessCheckAction(input: {
  hub: ProcessHub;
  organization: string;
  actId: string;
  action: ProcessCheckAction;
  teamId?: string | null;
  // 팀·파트 스코프(experience 필수). team_all=읽기전용(거부) / team_overall / part.
  //   part 일 때 partName 이 그 팀(org+mode)의 실제 파트여야 한다(타 파트/타 org/타 mode 강제 차단).
  scope?: ProcessCheckScopeKind | null;
  partName?: string | null;
  reviewLink?: unknown;
  scheduledCheckAt?: unknown;
  adminId: string;
  // 보드 조회와 동일한 주차로 저장하기 위한 스코프 모드(테스트=13주차 예외·info). 기본 operating.
  mode?: ScopeMode;
  // 드롭다운 선택 주차(weeks.id). 현재 주차와 다르면 활성 예외(process_check_windows)일 때만 허용.
  weekId?: string | null;
}): Promise<ProcessCheckActRowDto> {
  const { hub, organization, actId, action, adminId } = input;

  const week = await resolveWriteWeek(hub, input.mode ?? "operating", organization, input.weekId);
  if (!week?.weekId) {
    throw new ProcessMasterError(400, "현재 주차(weeks 행)를 찾을 수 없어 체크를 저장할 수 없습니다");
  }
  const weekId = week.weekId;

  // 팀 스코프 — experience 는 team_id 필수(org 소속 검증), 그 외 허브는 team_id 금지(NULL).
  const teamBased = isTeamBasedProcessHub(hub);
  const teamId = typeof input.teamId === "string" && input.teamId.trim() ? input.teamId.trim() : null;
  let teamName: string | null = null;
  if (teamBased) {
    if (!teamId) throw new ProcessMasterError(400, "팀(team_id)이 필요합니다");
    const { data: teamRow, error: teamErr } = await supabaseAdmin
      .from("cluster4_teams")
      .select("team_name")
      .eq("id", teamId)
      .eq("organization_slug", organization)
      .eq("is_active", true)
      .maybeSingle();
    if (teamErr) throw new ProcessMasterError(500, teamErr.message);
    if (!teamRow) throw new ProcessMasterError(400, "클럽에 속한 활성 팀이 아닙니다");
    teamName = (teamRow as { team_name: string }).team_name;
    // 모드 일치 재검증 — read 목록(filterTeamsByScope)과 동일 축으로 write 도 가드한다.
    //   test=(T)테스트 팀만 / operating=운영 팀만. 클라이언트가 mode 와 어긋나는 team_id 를
    //   보내도 DB write 0 으로 중단(fail-closed 422). org 는 위 쿼리에서 이미 강제됨.
    const writeMode = input.mode ?? "operating";
    if ((writeMode === "test") !== isTestTeam(organization, teamName)) {
      throw new ProcessMasterError(
        422,
        writeMode === "test"
          ? "테스트 모드에서는 테스트 팀만 체크할 수 있습니다"
          : "운영 모드에서는 운영(비테스트) 팀만 체크할 수 있습니다",
      );
    }
  } else if (teamId) {
    throw new ProcessMasterError(400, "이 허브는 팀 구분이 없습니다");
  }

  // 액트 검증 — 존재 · hub 일치 · 활성 · 체크 대상.
  const { data: actData, error: actErr } = await supabaseAdmin
    .from("process_acts")
    .select(
      "id,hub,line_group_id,act_name,check_target,is_active,duration_minutes,occur_week,occur_dow,occur_time,check_week,check_dow,check_time,point_check,point_advantage,point_penalty,act_type,cafe",
    )
    .eq("id", actId)
    .maybeSingle();
  if (actErr) throw migrationHint(actErr) ?? new ProcessMasterError(500, actErr.message);
  const act = actData as
    | (ActRow & { hub: string; is_active: boolean })
    | null;
  if (!act) throw new ProcessMasterError(404, "액트를 찾을 수 없습니다");
  if (act.hub !== hub) throw new ProcessMasterError(400, "액트의 허브가 일치하지 않습니다");
  if (!act.is_active) throw new ProcessMasterError(409, "비활성 액트는 체크할 수 없습니다");
  if (act.check_target !== "check") throw new ProcessMasterError(409, "체크 대상이 아닌 액트입니다");

  const { data: groupData } = await supabaseAdmin
    .from("process_line_groups")
    .select("name")
    .eq("id", act.line_group_id)
    .maybeSingle();
  const lineGroupName = (groupData as { name: string } | null)?.name ?? "-";

  // 팀·파트 스코프 검증 — 팀 구분 허브(experience)만. 프론트 숨김에 의존하지 않고 서버에서
  //   강제 POST(다른 팀/파트/org/mode 범위)를 fail-closed(422)로 차단한다.
  //   액트 파트 여부 = 라인급명("파트" 포함). 파트 식별 = user_memberships 실제 파트(listTeamParts).
  //   info 등 비팀 허브는 scope 미참조(회귀 금지).
  let partNameToStore: string | null = null;
  if (teamBased) {
    const scope = isProcessCheckScopeKind(input.scope) ? input.scope : null;
    if (!scope) {
      throw new ProcessMasterError(422, "체크 범위(scope: team_overall|part)가 필요합니다");
    }
    if (!isCheckableScope(scope)) {
      // team_all = 팀 전체 = 읽기 전용.
      throw new ProcessMasterError(422, "‘팀 전체’ 범위에서는 체크 신청/취소를 할 수 없습니다");
    }
    const actIsPart = isPartLineGroupName(lineGroupName);
    if (scope === "team_overall") {
      if (actIsPart) {
        throw new ProcessMasterError(422, "팀 총괄 범위에서는 파트 액트를 체크할 수 없습니다");
      }
      partNameToStore = null;
    } else {
      // scope === "part"
      if (!actIsPart) {
        throw new ProcessMasterError(422, "파트 범위에서는 파트 액트만 체크할 수 있습니다");
      }
      const claimedPart =
        typeof input.partName === "string" && input.partName.trim() ? input.partName.trim() : null;
      if (!claimedPart) throw new ProcessMasterError(422, "파트(part_name)가 필요합니다");
      // 선택 파트가 그 팀(org+mode)의 실제 파트인지 — 타 파트/타 org/타 mode 차단(fail-closed).
      const parts = teamName
        ? await listTeamParts(organization, teamName, input.mode ?? "operating")
        : [];
      if (!parts.includes(claimedPart)) {
        throw new ProcessMasterError(422, "선택한 파트가 이 팀(현재 모드/클럽)의 파트가 아닙니다");
      }
      // 파트별 독립 체크는 part_name 컬럼(v4) 필요 — 미적용이면 fail-closed.
      if (!(await partNameColumnAvailable())) {
        throw new ProcessMasterError(500, PART_MIGRATION_HINT);
      }
      partNameToStore = claimedPart;
    }
  }

  // 현재 상태 행 — 팀 구분 허브(experience)만 team_id + part_name 필터. info 는 미참조(v3/v4 무관·회귀 금지).
  let curQuery = supabaseAdmin
    .from("process_check_statuses")
    .select("id,status,scheduled_check_at")
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId)
    .eq("act_id", actId);
  if (teamBased) {
    curQuery = teamId ? curQuery.eq("team_id", teamId) : curQuery.is("team_id", null);
    // part_name 스코프 — v4 적용 시에만 필터(team_overall=IS NULL · part=eq). 미적용이면 미참조.
    if (await partNameColumnAvailable()) {
      curQuery = partNameToStore ? curQuery.eq("part_name", partNameToStore) : curQuery.is("part_name", null);
    }
  }
  const { data: cur, error: curErr } = await curQuery.maybeSingle();
  if (curErr) throw migrationHint(curErr) ?? new ProcessMasterError(500, curErr.message);
  const current = cur as
    | { id: string; status: ProcessCheckStatus; scheduled_check_at: string | null }
    | null;
  const curStatus: ProcessCheckStatus = current?.status ?? "needed";

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let logAction: ProcessCheckLogAction;
  let stamp: Record<string, unknown>;

  if (action === "request") {
    if (curStatus !== "needed") {
      throw new ProcessMasterError(
        409,
        curStatus === "completed" ? "체크 완료된 액트입니다" : "이미 체크 신청(대기)된 액트입니다",
      );
    }
    const link = validateReviewLink(input.reviewLink);
    if (!link.ok) throw new ProcessMasterError(400, link.error);
    if (typeof input.scheduledCheckAt !== "string") {
      throw new ProcessMasterError(400, "검수 시점은 필수입니다");
    }
    const sched = validateScheduledCheckAt(input.scheduledCheckAt, nowMs);
    if (!sched.ok) throw new ProcessMasterError(400, sched.error);

    logAction = "check_requested";
    stamp = {
      status: "pending",
      // 보드 모드(operating/test)를 행에 각인 — worker 크루 매칭 스코프(WORKER_MODES)와 정합.
      //   미기입 시 DB 기본값 'operating' 으로 저장되어, 테스트 보드(W13)에서 만든 신청도
      //   scope_mode='operating' 이 되어 WORKER_MODES=test worker 가 영원히 못 잡는다(체크 대기 고착).
      scope_mode: input.mode ?? "operating",
      review_link: link.value,
      scheduled_check_at: new Date(input.scheduledCheckAt).toISOString(),
      requested_at: nowIso,
      requested_by: adminId,
      completed_at: null,
      checked_crew_count: null,
    };
  } else {
    // cancel
    if (curStatus !== "pending") {
      throw new ProcessMasterError(
        409,
        curStatus === "completed" ? "체크 완료 후에는 취소할 수 없습니다" : "체크 대기 상태에서만 취소할 수 있습니다",
      );
    }
    const sched = current?.scheduled_check_at ? Date.parse(current.scheduled_check_at) : NaN;
    if (!Number.isNaN(sched) && nowMs >= sched) {
      throw new ProcessMasterError(409, "검수 시점이 지나 취소할 수 없습니다");
    }
    logAction = "check_cancelled";
    stamp = {
      status: "needed",
      review_link: null,
      scheduled_check_at: null,
      requested_at: null,
      requested_by: null,
      completed_at: null,
      checked_crew_count: null,
    };
  }

  // 저장(있으면 update, 없으면 insert).
  if (current) {
    const { error } = await supabaseAdmin
      .from("process_check_statuses")
      .update(stamp)
      .eq("id", current.id);
    if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  } else {
    const { error } = await supabaseAdmin.from("process_check_statuses").insert({
      organization_slug: organization,
      hub,
      week_id: weekId,
      // 팀 구분 허브만 team_id 기입(info 등은 컬럼 미참조 — v3 무관).
      ...(teamBased ? { team_id: teamId } : {}),
      // 팀 구분 허브 + v4 적용 시 part_name(part=파트명·team_overall=NULL). info/미적용은 미기입.
      ...(teamBased && (await partNameColumnAvailable()) ? { part_name: partNameToStore } : {}),
      line_group_id: act.line_group_id,
      act_id: actId,
      ...stamp,
    });
    if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }

  await insertProcessCheckLog({
    organization,
    hub,
    weekId,
    teamId,
    teamName,
    partName: teamBased ? partNameToStore : null,
    actId,
    lineGroupId: act.line_group_id,
    action: logAction,
    periodLabel: week.logPeriodLabel,
    lineGroupName,
    actName: act.act_name,
    adminId,
  });

  // 갱신된 행 DTO 반환(컴포넌트 즉시 반영용).
  const st = stamp as {
    status: ProcessCheckStatus;
    review_link: string | null;
    scheduled_check_at: string | null;
    requested_at: string | null;
    completed_at: string | null;
    checked_crew_count: number | null;
  };
  return {
    actId,
    lineGroupId: act.line_group_id,
    lineGroupName,
    // 변경 직후 낙관적 반영용 DTO — 행 id 는 직후 보드 refetch(buildRow)가 채운다(여기선 null).
    checkStatusId: null,
    partLabel: teamBased ? (partNameToStore ?? TEAM_OVERALL_LABEL) : TEAM_OVERALL_LABEL,
    actName: act.act_name,
    durationMinutes: act.duration_minutes,
    occurWhen: formatProcessWhen(act.occur_week as ProcessWeekRef, act.occur_dow, act.occur_time),
    checkWhen: formatProcessWhen(act.check_week as ProcessWeekRef, act.check_dow, act.check_time),
    pointCheck: act.point_check,
    pointAdvantage: act.point_advantage,
    pointPenalty: act.point_penalty,
    actType: act.act_type as ProcessActType,
    crewReactionLabel: PROCESS_ACT_TYPE_LABEL[act.act_type as ProcessActType] ?? act.act_type,
    cafeLabel: PROCESS_CAFE_LABEL[act.cafe as ProcessCafe] ?? act.cafe,
    isCheckTarget: true,
    status: st.status,
    completionType: null, // 신청/취소는 수동 부여가 아님
    reviewLink: st.review_link,
    scheduledCheckAt: st.scheduled_check_at,
    requestedAt: st.requested_at,
    completedAt: st.completed_at,
    checkedCrewCount: st.checked_crew_count,
    // 신청/취소는 completed 가 아님 — 체크 완료 명단 없음.
    completedCrewList: [],
    // 신청/취소 직후 — 검수는 아직 미실행(worker 미처리). 디버그는 not_started 기본값.
    reviewerDebug: {
      resolutionStatus: deriveReviewerResolutionStatus({
        status: st.status,
        lastError: null,
        matchedCount: st.checked_crew_count ?? 0,
        reviewCount: 0,
      }),
      crawledCommentCount: st.checked_crew_count ?? 0,
      matchedCrewCount: st.checked_crew_count ?? 0,
      unmatchedCommentAuthors: [],
      attemptCount: 0,
      lastError: null,
    },
  };
}

async function insertProcessCheckLog(input: {
  organization: string;
  hub: ProcessHub;
  weekId: string;
  teamId: string | null;
  teamName: string | null;
  partName: string | null;
  actId: string;
  lineGroupId: string;
  action: ProcessCheckLogAction;
  periodLabel: string;
  lineGroupName: string;
  actName: string;
  // 행위자 — adminId(프로필 display_name 해소) 또는 actorName(시스템 라벨 직접 지정).
  //   자동 검수 완료(sweep)처럼 관리자 손이 아닌 경로는 actorName="자동 검수" 로 남긴다.
  adminId?: string | null;
  actorName?: string | null;
}): Promise<void> {
  try {
    let actorName = "관리자";
    if (input.actorName && input.actorName.trim()) {
      actorName = input.actorName.trim();
    } else if (input.adminId) {
      const { data: prof } = await supabaseAdmin
        .from("user_profiles")
        .select("display_name")
        .eq("user_id", input.adminId)
        .maybeSingle();
      const dn = (prof as { display_name: string | null } | null)?.display_name?.trim();
      if (dn) actorName = dn;
    }

    const baseFields = {
      organization_slug: input.organization,
      hub: input.hub,
      week_id: input.weekId,
      // 팀 구분 허브만 team 필드 기입(info 등은 컬럼 미참조 — v3 무관·로그 회귀 방지).
      ...(input.teamId || input.teamName ? { team_id: input.teamId, team_name: input.teamName } : {}),
      act_id: input.actId,
      line_group_id: input.lineGroupId,
      period_label: input.periodLabel,
      line_group_name: input.lineGroupName,
      act_name: input.actName,
      actor_name: actorName,
    };
    // 한 액션값으로 insert 시도 — v4 적용 시 part_name(denorm) 포함. 미적용(42703)이면 part_name 없이 재시도.
    const attempt = async (action: string) => {
      const base = { ...baseFields, action };
      const withPart = input.teamId ? { ...base, part_name: input.partName } : base;
      let { error } = await supabaseAdmin.from("process_check_logs").insert(withPart);
      if (error && isPartColumnMissing(error) && withPart !== base) {
        ({ error } = await supabaseAdmin.from("process_check_logs").insert(base));
      }
      return error;
    };
    let error = await attempt(input.action);
    // action CHECK 제약 미확장(check_rolled_back 거부) → check_cancelled 로 폴백(로그 유실 방지).
    //   2026-07-04_process_check_logs_rollback_action.sql 적용 후에는 정식 값으로 기록된다.
    if (error && isActionCheckConstraint(error) && input.action === "check_rolled_back") {
      error = await attempt("check_cancelled");
    }
    if (error) console.warn("[process-check-logs] insert skipped:", error.message);
  } catch (e) {
    console.warn("[process-check-logs] insert failed:", e instanceof Error ? e.message : e);
  }
}

// 자동 완료 로그의 행위자 라벨(관리자 버튼이 아닌 시스템 경로 — 검수 sweep/cron 등).
const PROCESS_CHECK_AUTO_ACTOR = "자동 검수";

// week_id → 로그 주차 라벨("26년 여름 시즌 2주차"). 요청 로그가 없을 때의 폴백 파생. 실패 시 "-".
async function deriveLogPeriodLabel(weekId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("id", weekId)
    .maybeSingle();
  const startDate = (data as { start_date: string | null } | null)?.start_date;
  if (!startDate) return "-";
  const ms = Date.parse(startDate.length <= 10 ? `${startDate}T00:00:00Z` : startDate);
  if (Number.isNaN(ms)) return "-";
  const d = describeWeekByStartMs(ms);
  if (!d) return "-";
  return processCheckLogPeriodLabel({ year: d.year, seasonName: d.seasonName, weekNumber: d.weekNumber });
}

// 정규(regular) 체크 행 1건의 로그 표시 컨텍스트(denorm) — 완료/실행취소 로그가 공유.
//   표시값(주차/라인급/액트/팀·파트)은 같은 스코프의 check_requested 로그를 그대로 재사용해
//   "요청-완료-실행취소" 문장의 텍스트가 로그창에서 일치하게 한다(없으면 마스터/주차에서 파생).
type RegularLogContext = {
  organization: string;
  hub: ProcessHub;
  weekId: string;
  teamId: string | null;
  teamName: string | null;
  partName: string | null;
  actId: string;
  lineGroupId: string;
  periodLabel: string;
  lineGroupName: string;
  actName: string;
  status: string;
};

async function resolveRegularLogContext(statusRowId: string): Promise<RegularLogContext | null> {
  const partAvail = await partNameColumnAvailable();
  const sel = partAvail
    ? "organization_slug,hub,week_id,act_id,line_group_id,team_id,part_name,status"
    : "organization_slug,hub,week_id,act_id,line_group_id,team_id,status";
  const { data: rowData, error: rowErr } = await supabaseAdmin
    .from("process_check_statuses")
    .select(sel)
    .eq("id", statusRowId)
    .maybeSingle();
  if (rowErr || !rowData) return null;
  const r = rowData as unknown as {
    organization_slug: string;
    hub: string;
    week_id: string | null;
    act_id: string;
    line_group_id: string | null;
    team_id: string | null;
    part_name?: string | null;
    status: string;
  };
  if (!r.week_id) return null;
  const hub = r.hub as ProcessHub;
  const weekId = r.week_id;
  const teamId = r.team_id ?? null;
  const partName = partAvail ? (r.part_name ?? null) : null;

  // 표시값(denorm) — 같은 스코프의 check_requested 로그 재사용(요청-완료 쌍 일관). 없으면 마스터 파생.
  let reqQ = supabaseAdmin
    .from("process_check_logs")
    .select("period_label,line_group_name,act_name")
    .eq("organization_slug", r.organization_slug)
    .eq("hub", hub)
    .eq("week_id", weekId)
    .eq("act_id", r.act_id)
    .eq("action", "check_requested");
  reqQ = teamId ? reqQ.eq("team_id", teamId) : reqQ.is("team_id", null);
  if (partAvail) reqQ = partName ? reqQ.eq("part_name", partName) : reqQ.is("part_name", null);
  const { data: reqLog } = await reqQ
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const rl = reqLog as
    | { period_label: string; line_group_name: string; act_name: string }
    | null;

  let periodLabel: string;
  let lineGroupName: string;
  let actName: string;
  let lineGroupId = r.line_group_id ?? "";
  if (rl) {
    periodLabel = rl.period_label;
    lineGroupName = rl.line_group_name;
    actName = rl.act_name;
  } else {
    // 폴백 — 요청 로그가 없는 예외 경로. 마스터/주차에서 파생.
    const { data: actRow } = await supabaseAdmin
      .from("process_acts")
      .select("act_name,line_group_id")
      .eq("id", r.act_id)
      .maybeSingle();
    actName = (actRow as { act_name: string } | null)?.act_name ?? "-";
    lineGroupId = lineGroupId || (actRow as { line_group_id: string } | null)?.line_group_id || "";
    lineGroupName = "-";
    if (lineGroupId) {
      const { data: g } = await supabaseAdmin
        .from("process_line_groups")
        .select("name")
        .eq("id", lineGroupId)
        .maybeSingle();
      lineGroupName = (g as { name: string } | null)?.name ?? "-";
    }
    periodLabel = await deriveLogPeriodLabel(weekId);
  }

  const teamName = teamId ? await resolveTeamName(teamId, r.organization_slug) : null;

  return {
    organization: r.organization_slug,
    hub,
    weekId,
    teamId,
    teamName,
    partName,
    actId: r.act_id,
    lineGroupId,
    periodLabel,
    lineGroupName,
    actName,
    status: r.status,
  };
}

// ── 검수 완료 로그 — 정규 행이 completed 로 "전환되는 순간" 1회 기록 ──────────────────────
//   호출처: 자동 sweep(runDueProcessCheckSweep) + 즉시 검수(runProcessCheckRowNow).
//   행위자(actor_name):
//     · adminId 지정(운영자가 [즉시 검수] 버튼을 누른 경우) → 그 관리자 display_name.
//     · adminId 미지정(스케줄러 자동 sweep) → 시스템 라벨 "자동 검수".
//   멱등(중복 방지) + 재검수 허용: 같은 (org,hub,week,act,team,part) 스코프에서 "가장 최근"의
//     완료/되돌림 이벤트가 이미 check_completed 면 재기록 안 함(즉시 검수 = sweep→강제완료 두 경로가
//     모두 이 함수를 호출하므로 첫 기록만 남긴다). 반대로 그 사이 실행 취소(check_rolled_back·미적용
//     폴백 check_cancelled)가 끼면 최신 이벤트가 되돌림 → 재검수는 새 [체크 완료] 로그로 남긴다.
//   변동(irregular)은 process_check_logs(허브 기반)를 쓰지 않으므로 정규(source='regular')만 대상.
//   ⚠ snapshot/user_weekly_points/적립 무접촉 — 로그 1행만. best-effort(실패가 sweep 을 깨지 않음).
export async function logProcessCheckCompletedForRegular(
  statusRowId: string,
  opts: { adminId?: string | null } = {},
): Promise<void> {
  try {
    const ctx = await resolveRegularLogContext(statusRowId);
    if (!ctx) return;
    if (ctx.status !== "completed") return; // 실제 completed 전환 행만(방어).

    // 멱등 가드 — 스코프의 완료/되돌림 이벤트 중 "최신"이 check_completed 면 재기록 안 함.
    //   되돌림(check_rolled_back 또는 폴백 check_cancelled)이 마지막이면 재검수 → 새 완료 로그 허용.
    let dupQ = supabaseAdmin
      .from("process_check_logs")
      .select("action,created_at")
      .eq("organization_slug", ctx.organization)
      .eq("hub", ctx.hub)
      .eq("week_id", ctx.weekId)
      .eq("act_id", ctx.actId)
      .in("action", ["check_completed", "check_rolled_back", "check_cancelled"]);
    dupQ = ctx.teamId ? dupQ.eq("team_id", ctx.teamId) : dupQ.is("team_id", null);
    if (await partNameColumnAvailable()) {
      dupQ = ctx.partName ? dupQ.eq("part_name", ctx.partName) : dupQ.is("part_name", null);
    }
    const { data: dup, error: dupErr } = await dupQ
      .order("created_at", { ascending: false })
      .limit(1);
    if (!dupErr && dup && dup.length > 0 && (dup[0] as { action: string }).action === "check_completed") {
      return; // 최신 이벤트가 완료 → 이미 [체크 완료] 기록됨(중복 방지).
    }

    const adminId = opts.adminId?.trim() || null;
    await insertProcessCheckLog({
      organization: ctx.organization,
      hub: ctx.hub,
      weekId: ctx.weekId,
      teamId: ctx.teamId,
      teamName: ctx.teamName,
      partName: ctx.partName,
      actId: ctx.actId,
      lineGroupId: ctx.lineGroupId,
      action: "check_completed",
      periodLabel: ctx.periodLabel,
      lineGroupName: ctx.lineGroupName,
      actName: ctx.actName,
      // 관리자 버튼(즉시 검수) → 관리자 이름 · 자동 sweep → "자동 검수".
      ...(adminId ? { adminId } : { actorName: PROCESS_CHECK_AUTO_ACTOR }),
    });
  } catch (e) {
    console.warn("[process-check-logs] complete log failed:", e instanceof Error ? e.message : e);
  }
}

// ── 실행 취소(↩) 로그 — 정규 행이 completed→pending 으로 되돌려질 때 1회 기록 ─────────────
//   호출처: rollbackProcessCheckCompletion(실행 취소 API). 관리자 버튼 이벤트이므로 adminId 필수 —
//   actor_name 은 그 관리자 display_name(자동 검수 아님). 멱등 dedup 없음(취소는 매번 별도 이벤트로
//   시간순 누적). 표시값(denorm)은 완료 로그와 동일 컨텍스트 재사용 → 요청-완료-실행취소 문장 일치.
//   ⚠ 로그 1행만 — 포인트 회수/snapshot 재계산은 rollback lib 이 담당. best-effort(로그 실패가 취소를 안 깸).
export async function logProcessCheckRolledBackForRegular(
  statusRowId: string,
  opts: { adminId?: string | null } = {},
): Promise<void> {
  try {
    const ctx = await resolveRegularLogContext(statusRowId);
    if (!ctx) return;
    await insertProcessCheckLog({
      organization: ctx.organization,
      hub: ctx.hub,
      weekId: ctx.weekId,
      teamId: ctx.teamId,
      teamName: ctx.teamName,
      partName: ctx.partName,
      actId: ctx.actId,
      lineGroupId: ctx.lineGroupId,
      action: "check_rolled_back",
      periodLabel: ctx.periodLabel,
      lineGroupName: ctx.lineGroupName,
      actName: ctx.actName,
      adminId: opts.adminId?.trim() || null,
    });
  } catch (e) {
    console.warn("[process-check-logs] rollback log failed:", e instanceof Error ? e.message : e);
  }
}

// ── 선별(selection) 액트 수동 부여 (2026-06-18) ─────────────────────────────────
//   관리자가 대상 크루 + 포인트(A/B/C)를 직접 입력해 즉시 완료(completion_type='manual_grant').
//   - 액트 종류(act_type)='선별' 만 허용(필수/기타 등은 422). '선별' 규칙상 포인트 C=0 강제.
//   - 상태 행(org,hub,week,act,team,part)을 completed + manual_grant 로 각인 + override 점수 저장.
//   - 대상 크루 = process_check_review_recipients(source='regular', ref_id=status.id, matched).
//     중복 부여 방지 = 같은 ref_id 내 user_id 중복 스킵(+ 원장 UNIQUE(source,ref_id,user_id)).
//   - 포인트 적립/주차 성장/snapshot = accrueForCompletedRegular(status.id) 단일 SoT 재사용
//     (era 경계·org/mode 스코프·원장 멱등은 helper 내부). best-effort 격리.
export async function applyProcessManualGrant(input: {
  hub: ProcessHub;
  organization: string;
  actId: string;
  teamId?: string | null;
  scope?: ProcessCheckScopeKind | null;
  partName?: string | null;
  mode?: ScopeMode;
  // 드롭다운 선택 주차(weeks.id). 현재 주차와 다르면 활성 예외(process_check_windows)일 때만 허용.
  weekId?: string | null;
  adminId: string;
  targetUserIds: unknown; // string[]
  durationMinutes?: unknown;
  reason?: unknown;
  pointCheck?: unknown;
  pointAdvantage?: unknown;
  pointPenalty?: unknown;
}): Promise<ProcessCheckActRowDto> {
  const { hub, organization, actId, adminId } = input;
  const mode: ScopeMode = input.mode ?? "operating";

  // 수동 부여 컬럼(completion_type 등) 미적용이면 fail-closed(잘못된 저장 방지).
  if (!(await completionColumnsAvailable())) {
    throw new ProcessMasterError(500, MANUAL_GRANT_MIGRATION_HINT);
  }

  const week = await resolveWriteWeek(hub, mode, organization, input.weekId);
  if (!week?.weekId) {
    throw new ProcessMasterError(400, "현재 주차(weeks 행)를 찾을 수 없어 수동 부여를 저장할 수 없습니다");
  }
  const weekId = week.weekId;

  // 팀 스코프(experience) — applyProcessCheckAction 과 동일 가드(org 소속 + 모드 일치 fail-closed).
  const teamBased = isTeamBasedProcessHub(hub);
  const teamId = typeof input.teamId === "string" && input.teamId.trim() ? input.teamId.trim() : null;
  let teamName: string | null = null;
  if (teamBased) {
    if (!teamId) throw new ProcessMasterError(400, "팀(team_id)이 필요합니다");
    const { data: teamRow, error: teamErr } = await supabaseAdmin
      .from("cluster4_teams")
      .select("team_name")
      .eq("id", teamId)
      .eq("organization_slug", organization)
      .eq("is_active", true)
      .maybeSingle();
    if (teamErr) throw new ProcessMasterError(500, teamErr.message);
    if (!teamRow) throw new ProcessMasterError(400, "클럽에 속한 활성 팀이 아닙니다");
    teamName = (teamRow as { team_name: string }).team_name;
    if ((mode === "test") !== isTestTeam(organization, teamName)) {
      throw new ProcessMasterError(
        422,
        mode === "test"
          ? "테스트 모드에서는 테스트 팀만 부여할 수 있습니다"
          : "운영 모드에서는 운영(비테스트) 팀만 부여할 수 있습니다",
      );
    }
  } else if (teamId) {
    throw new ProcessMasterError(400, "이 허브는 팀 구분이 없습니다");
  }

  // 액트 검증 — 존재·hub 일치·활성·체크 대상·'선별' 액트.
  const { data: actData, error: actErr } = await supabaseAdmin
    .from("process_acts")
    .select(
      "id,hub,line_group_id,act_name,check_target,is_active,act_type,duration_minutes,occur_week,occur_dow,occur_time,check_week,check_dow,check_time,point_check,point_advantage,point_penalty,cafe",
    )
    .eq("id", actId)
    .maybeSingle();
  if (actErr) throw migrationHint(actErr) ?? new ProcessMasterError(500, actErr.message);
  const act = actData as (ActRow & { hub: string; is_active: boolean }) | null;
  if (!act) throw new ProcessMasterError(404, "액트를 찾을 수 없습니다");
  if (act.hub !== hub) throw new ProcessMasterError(400, "액트의 허브가 일치하지 않습니다");
  if (!act.is_active) throw new ProcessMasterError(409, "비활성 액트는 부여할 수 없습니다");
  if (act.check_target !== "check") throw new ProcessMasterError(409, "체크 대상이 아닌 액트입니다");
  if (act.act_type !== "selection") {
    throw new ProcessMasterError(422, "수동 부여는 ‘선별’ 액트에만 가능합니다");
  }

  const { data: groupData } = await supabaseAdmin
    .from("process_line_groups")
    .select("name")
    .eq("id", act.line_group_id)
    .maybeSingle();
  const lineGroupName = (groupData as { name: string } | null)?.name ?? "-";

  // 팀·파트 스코프(experience) — part_name 저장값 결정(applyProcessCheckAction 과 동일 가드).
  let partNameToStore: string | null = null;
  if (teamBased) {
    const scopeKind = isProcessCheckScopeKind(input.scope) ? input.scope : null;
    if (!scopeKind) throw new ProcessMasterError(422, "체크 범위(scope: team_overall|part)가 필요합니다");
    if (!isCheckableScope(scopeKind)) {
      throw new ProcessMasterError(422, "‘팀 전체’ 범위에서는 수동 부여를 할 수 없습니다");
    }
    const actIsPart = isPartLineGroupName(lineGroupName);
    if (scopeKind === "team_overall") {
      if (actIsPart) throw new ProcessMasterError(422, "팀 총괄 범위에서는 파트 액트를 부여할 수 없습니다");
      partNameToStore = null;
    } else {
      if (!actIsPart) throw new ProcessMasterError(422, "파트 범위에서는 파트 액트만 부여할 수 있습니다");
      const claimedPart =
        typeof input.partName === "string" && input.partName.trim() ? input.partName.trim() : null;
      if (!claimedPart) throw new ProcessMasterError(422, "파트(part_name)가 필요합니다");
      const parts = teamName ? await listTeamParts(organization, teamName, mode) : [];
      if (!parts.includes(claimedPart)) {
        throw new ProcessMasterError(422, "선택한 파트가 이 팀(현재 모드/클럽)의 파트가 아닙니다");
      }
      if (!(await partNameColumnAvailable())) throw new ProcessMasterError(500, PART_MIGRATION_HINT);
      partNameToStore = claimedPart;
    }
  }

  // 포인트(자유 입력) — 0~20 · '선별' 규칙상 C=0 강제(enforcePointC).
  const pCheck = Number(input.pointCheck ?? 0);
  const pAdv = Number(input.pointAdvantage ?? 0);
  let pPen = Number(input.pointPenalty ?? 0);
  if (!isProcessPoint(pCheck) || !isProcessPoint(pAdv) || !isProcessPoint(pPen)) {
    throw new ProcessMasterError(400, "포인트 A/B/C 는 0~20 이어야 합니다");
  }
  pPen = enforcePointC("selection", pPen); // 선별 → 0 고정

  // 소요시간/사유(표시·관리용).
  let durationMinutes: number | null = null;
  if (input.durationMinutes !== undefined && input.durationMinutes !== null && input.durationMinutes !== "") {
    const d = Number(input.durationMinutes);
    if (!Number.isInteger(d) || d < 1 || d > 600) {
      throw new ProcessMasterError(400, "소요 시간은 1~600분(정수)이어야 합니다");
    }
    durationMinutes = d;
  }
  const reason =
    typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 200) : null;

  // 대상 크루 — org+mode 스코프 전원 검증(fail-closed 422) + 소속/이름 확정.
  const ids = Array.isArray(input.targetUserIds)
    ? Array.from(
        new Set(
          input.targetUserIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0),
        ),
      )
    : [];
  if (ids.length === 0) throw new ProcessMasterError(400, "수동 부여는 대상 크루를 1명 이상 선택해야 합니다");
  const scope = await resolveUserScope(mode, organization as OrganizationSlug);
  assertUserIdsInScope(scope, ids);
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", ids);
  if (pErr) throw new ProcessMasterError(500, pErr.message);
  const profRows = (profs ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  }>;
  const byId = new Map(profRows.map((r) => [r.user_id, r]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) throw new ProcessMasterError(404, "대상 크루(user_profiles)를 찾을 수 없습니다");
    if (p.organization_slug !== organization) {
      throw new ProcessMasterError(422, "대상 크루가 해당 클럽(org) 소속이 아닙니다");
    }
  }

  // 현재 상태 행 — 같은 스코프(team/part)로 1행. 검수 진행/검수 완료와 충돌 차단.
  let curQuery = supabaseAdmin
    .from("process_check_statuses")
    .select("id,status,completion_type")
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId)
    .eq("act_id", actId);
  if (teamBased) {
    curQuery = teamId ? curQuery.eq("team_id", teamId) : curQuery.is("team_id", null);
    if (await partNameColumnAvailable()) {
      curQuery = partNameToStore ? curQuery.eq("part_name", partNameToStore) : curQuery.is("part_name", null);
    }
  }
  const { data: cur, error: curErr } = await curQuery.maybeSingle();
  if (curErr) throw migrationHint(curErr) ?? new ProcessMasterError(500, curErr.message);
  const current = cur as { id: string; status: ProcessCheckStatus; completion_type: string | null } | null;
  if (current) {
    if (current.status === "pending") {
      throw new ProcessMasterError(409, "링크 신청으로 체크 대기 중인 액트입니다. 먼저 체크 취소 후 수동 부여하세요.");
    }
    if (current.status === "completed" && current.completion_type !== "manual_grant") {
      throw new ProcessMasterError(409, "이미 검수로 체크 완료된 액트입니다.");
    }
  }
  // 이미 완료(manual_grant 재부여)면 [체크 완료] 로그를 재기록하지 않는다 — 중복 방지.
  //   체크 완료 로그는 "completed 로 전환되는 순간"에만 1회 남긴다(요구사항 #4).
  const wasAlreadyCompleted = current?.status === "completed";

  const nowIso = new Date().toISOString();
  const stamp = {
    status: "completed",
    completion_type: "manual_grant",
    scope_mode: mode,
    review_link: null,
    scheduled_check_at: nowIso, // 신청==검수==완료(개념)
    requested_at: nowIso,
    requested_by: adminId,
    completed_at: nowIso,
    manual_point_check: pCheck,
    manual_point_advantage: pAdv,
    manual_point_penalty: pPen,
    manual_reason: reason,
    manual_duration_minutes: durationMinutes,
    last_error: null,
  };

  let statusRowId: string;
  if (current) {
    const { error } = await supabaseAdmin.from("process_check_statuses").update(stamp).eq("id", current.id);
    if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
    statusRowId = current.id;
  } else {
    const { data: ins, error } = await supabaseAdmin
      .from("process_check_statuses")
      .insert({
        organization_slug: organization,
        hub,
        week_id: weekId,
        ...(teamBased ? { team_id: teamId } : {}),
        ...(teamBased && (await partNameColumnAvailable()) ? { part_name: partNameToStore } : {}),
        line_group_id: act.line_group_id,
        act_id: actId,
        ...stamp,
      })
      .select("id")
      .single();
    if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
    statusRowId = (ins as { id: string }).id;
  }

  // 대상 크루 → recipients(matched). 중복 부여 방지 = 같은 ref_id 내 기존 user_id 스킵.
  const { data: existRec } = await supabaseAdmin
    .from("process_check_review_recipients")
    .select("user_id")
    .eq("source", "regular")
    .eq("ref_id", statusRowId);
  const existing = new Set(
    ((existRec ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter(Boolean) as string[],
  );
  const newIds = ids.filter((id) => !existing.has(id));
  if (newIds.length > 0) {
    const recRows = newIds.map((id) => ({
      source: "regular",
      ref_id: statusRowId,
      organization_slug: organization,
      scope_mode: mode,
      user_id: id,
      nickname: byId.get(id)?.display_name?.trim() || "(이름 없음)",
      match_type: "matched",
      match_reason: "manual",
    }));
    const { error: recErr } = await supabaseAdmin.from("process_check_review_recipients").insert(recRows);
    if (recErr) throw migrationHint(recErr) ?? new ProcessMasterError(500, recErr.message);
  }
  const totalCrew = existing.size + newIds.length;
  await supabaseAdmin
    .from("process_check_statuses")
    .update({ checked_crew_count: totalCrew })
    .eq("id", statusRowId);

  // 체크 완료 명단(이름·팀·파트·클래스) — 이번 부여 후 전체 수신 크루(기존 ∪ 신규).
  const allCrewIds = Array.from(new Set<string>([...existing, ...newIds]));
  const crewMeta = await resolveCrewMeta(allCrewIds);
  const completedCrewList = allCrewIds
    .map((id) => toCrewDto(crewMeta, id, byId.get(id)?.display_name ?? null))
    .sort((a, b) => a.name.localeCompare(b.name));

  // 포인트 적립(완료 즉시) — best-effort 격리(적립 실패가 부여를 깨지 않게).
  //   era 경계(operating=summer+/test=+W13) 미허용 주차면 적립 스킵(기록만 남음).
  try {
    const acc = await accrueForCompletedRegular(statusRowId);
    if ("skipped" in acc && acc.skipped) {
      console.log("[accrual] manual_grant(정규) 적립 스킵", { statusRowId, reason: acc.reason });
    }
  } catch (e) {
    console.warn("[accrual] manual_grant(정규) 적립 실패(격리)", {
      statusRowId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  if (!wasAlreadyCompleted) {
    await insertProcessCheckLog({
      organization,
      hub,
      weekId,
      teamId,
      teamName,
      partName: teamBased ? partNameToStore : null,
      actId,
      lineGroupId: act.line_group_id,
      action: "check_completed",
      periodLabel: week.logPeriodLabel,
      lineGroupName,
      actName: act.act_name,
      adminId,
    });
  }

  return {
    actId,
    lineGroupId: act.line_group_id,
    lineGroupName,
    // 변경 직후 낙관적 반영용 DTO — 행 id 는 직후 보드 refetch(buildRow)가 채운다(여기선 null).
    checkStatusId: null,
    partLabel: teamBased ? (partNameToStore ?? TEAM_OVERALL_LABEL) : TEAM_OVERALL_LABEL,
    actName: act.act_name,
    durationMinutes: act.duration_minutes,
    occurWhen: formatProcessWhen(act.occur_week as ProcessWeekRef, act.occur_dow, act.occur_time),
    checkWhen: formatProcessWhen(act.check_week as ProcessWeekRef, act.check_dow, act.check_time),
    pointCheck: act.point_check,
    pointAdvantage: act.point_advantage,
    pointPenalty: act.point_penalty,
    actType: "selection",
    crewReactionLabel: PROCESS_ACT_TYPE_LABEL["selection"],
    cafeLabel: PROCESS_CAFE_LABEL[act.cafe as ProcessCafe] ?? act.cafe,
    isCheckTarget: true,
    status: "completed",
    completionType: "manual_grant",
    reviewLink: null,
    scheduledCheckAt: nowIso,
    requestedAt: nowIso,
    completedAt: nowIso,
    checkedCrewCount: totalCrew,
    completedCrewList,
    reviewerDebug: {
      resolutionStatus: deriveReviewerResolutionStatus({
        status: "completed",
        lastError: null,
        matchedCount: totalCrew,
        reviewCount: 0,
      }),
      crawledCommentCount: totalCrew,
      matchedCrewCount: totalCrew,
      unmatchedCommentAuthors: [],
      attemptCount: 0,
      lastError: null,
    },
  };
}
