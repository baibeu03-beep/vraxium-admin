// Server-only data layer for 프로세스 체크 (/admin/processes/check/{hub}) — 체크 동작 Phase.
//
// 마스터(process_line_groups · process_acts) 읽기 + process_check_statuses/process_check_logs
// (org×hub×week×act 체크 상태/이력) 읽기·쓰기. 기존 SoT(cluster4_lines · user_weekly_points ·
// snapshot 경로 · checkGate)는 일절 참조/수정하지 않는다. weeks 는 현재 주차 lookup(읽기)만.
// 포인트 부여/크롤링(완료 트리거)은 본 Phase 범위 밖.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import {
  PROCESS_ACT_TYPE_LABEL,
  PROCESS_CAFE_LABEL,
  PROCESS_HUB_LABEL,
  formatProcessWhen,
  type ProcessActType,
  type ProcessCafe,
  type ProcessHub,
  type ProcessWeekRef,
} from "@/lib/adminProcessesTypes";
import {
  describeWeekByStartMs,
  getCurrentWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { filterTeamsByScope, isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  processCheckLogPeriodLabel,
  processCheckPeriodLabel,
  validateReviewLink,
  validateScheduledCheckAt,
  type ProcessCheckAction,
  type ProcessCheckActRowDto,
  type ProcessCheckBoardDto,
  type ProcessCheckLineGroupDto,
  type ProcessCheckLogAction,
  type ProcessCheckLogDto,
  isTeamBasedProcessHub,
  type ProcessCheckStatus,
  type ProcessCheckSummary,
  type ProcessCheckTeamDto,
  type ProcessCheckWeekDto,
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

// ── 현재 주차 (이번 주 N — 월~일) + weeks.id ─────────────────────────────────
const WEEK_MS = 7 * 86_400_000;

// 13주차(테스트) 예외를 받는 허브 — info 만(운영 정책/다른 check 화면·line-opening 무영향).
//   ⚠ 이 술어를 좁게 유지해야 "info 에만 적용" 보장. 다른 허브로 확장 시 여기만 수정.
function hubAllowsTestWeekException(hub: ProcessHub): boolean {
  return hub === "info";
}

// 보드 기준 주차(시작 ms) 결정 — mode + 예외 허용 여부만으로 결정(허브 무관 공용 SoT).
//   운영 모드 / 예외 미허용 → 실제 현재 주차 N(기존 정책 유지).
//   테스트 모드 + 예외 허용(info·비정규 액트) → 현재 주차가 휴식 주차여도 "마지막 운영(running)
//     주차"로 walk-back(현 2026-봄 = 13주차). 활동 주차면 walk-back 결과 = 현재 주차(불변).
//   ⚠ "13"을 하드코딩하지 않고 시즌 캘린더(isOfficialRest)에서 동적 산출 — 시즌 바뀌어도 안전.
export function resolveProcessWeekStartMs(mode: ScopeMode, allowTestException: boolean): number | null {
  const todayIso = new Date().toISOString().slice(0, 10);
  const curMs = getCurrentWeekStartMs(todayIso);
  if (curMs == null) return null;
  if (mode !== "test" || !allowTestException) return curMs;
  // 테스트 모드(예외 허용) — 휴식 아닌(운영) 주차를 만날 때까지 1주씩 뒤로(시즌 시작 이전이면 중단).
  let ms = curMs;
  for (let i = 0; i < 24; i++) {
    const d = describeWeekByStartMs(ms);
    if (!d) break; // 시즌 시작 이전 → 더 못 감
    if (!d.isOfficialRest) return ms; // 운영 주차 발견(= 마지막 활동 주차)
    ms -= WEEK_MS;
  }
  return curMs; // 운영 주차 못 찾음 → 현재 주차(fail-safe = 운영 동작)
}

// 주차 DTO 빌더(weeks.id lookup + 라벨) — 허브 무관 공용. 비정규 액트도 이 SoT 를 재사용.
export async function resolveProcessWeek(
  mode: ScopeMode,
  allowTestException: boolean,
): Promise<ProcessCheckWeekDto | null> {
  const ms = resolveProcessWeekStartMs(mode, allowTestException);
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
    year: d.year,
    seasonName: d.seasonName,
    weekNumber: d.weekNumber,
    startDate: d.weekStart,
    endDate: d.weekEnd,
    periodLabel: processCheckPeriodLabel(base),
    logPeriodLabel: processCheckLogPeriodLabel(base),
  };
}

// 허브 기준 현재 주차(기존 호출부 유지) — 예외 허용 여부를 허브 술어로 결정해 공용 빌더에 위임.
function resolveCurrentWeek(hub: ProcessHub, mode: ScopeMode): Promise<ProcessCheckWeekDto | null> {
  return resolveProcessWeek(mode, hubAllowsTestWeekException(hub));
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
  act_id: string;
  status: string;
  review_link: string | null;
  scheduled_check_at: string | null;
  requested_at: string | null;
  completed_at: string | null;
  checked_crew_count: number | null;
};
type StatusState = {
  status: ProcessCheckStatus;
  reviewLink: string | null;
  scheduledCheckAt: string | null;
  requestedAt: string | null;
  completedAt: string | null;
  checkedCrewCount: number | null;
};
const STATUS_SELECT =
  "act_id,status,review_link,scheduled_check_at,requested_at,completed_at,checked_crew_count";

async function loadStatuses(
  organization: string,
  hub: ProcessHub,
  weekId: string,
  teamId: string | null,
): Promise<Map<string, StatusState>> {
  const map = new Map<string, StatusState>();
  let query = supabaseAdmin
    .from("process_check_statuses")
    .select(STATUS_SELECT)
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId);
  // 팀 스코프 — 팀 구분 허브(experience)만 team_id 필터(일치 / IS NULL). info 등은 team_id 미참조
  //   (v3 미적용 환경에서도 info 가 깨지지 않도록 — 회귀 금지).
  if (isTeamBasedProcessHub(hub)) {
    query = teamId ? query.eq("team_id", teamId) : query.is("team_id", null);
  }
  const { data, error } = await query;
  if (error) {
    console.warn("[process-check-statuses] read unavailable:", error.message);
    return map;
  }
  for (const r of (data ?? []) as StatusRow[]) {
    const status: ProcessCheckStatus =
      r.status === "pending" || r.status === "completed" ? r.status : "needed";
    map.set(r.act_id, {
      status,
      reviewLink: r.review_link,
      scheduledCheckAt: r.scheduled_check_at,
      requestedAt: r.requested_at,
      completedAt: r.completed_at,
      checkedCrewCount: r.checked_crew_count,
    });
  }
  return map;
}

const NEEDED: StatusState = {
  status: "needed",
  reviewLink: null,
  scheduledCheckAt: null,
  requestedAt: null,
  completedAt: null,
  checkedCrewCount: null,
};

// ── 보드 조회 ─────────────────────────────────────────────────────────────────
export async function getProcessCheckBoard(
  hub: ProcessHub,
  organization: string,
  // teamId: experience 섹션.1 선택 팀(team_id 스코프). null = 섹션.0/info(team_id IS NULL).
  teamId: string | null = null,
  // 팀 목록 스코프(operating=운영 팀만 / test=(T) 팀만). 기본 operating.
  mode: ScopeMode = "operating",
): Promise<ProcessCheckBoardDto> {
  const week = await resolveCurrentWeek(hub, mode);
  const { groups, acts } = await loadActiveMaster(hub);
  const statusByAct = week?.weekId
    ? await loadStatuses(organization, hub, week.weekId, teamId)
    : new Map<string, StatusState>();
  // 팀 구분 허브면 org 팀 동적 조회(상태창1 팀별 문장 + 섹션.1 탭). 그 외는 빈 배열(허브 전체 1문장).
  const teams = isTeamBasedProcessHub(hub)
    ? await loadProcessCheckTeams(organization, mode)
    : [];

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
  const flatActs: ProcessCheckActRowDto[] = sortedActs.map((a) => {
    const st = statusByAct.get(a.id) ?? NEEDED;
    return {
      actId: a.id,
      lineGroupId: a.line_group_id,
      lineGroupName: groupNameById.get(a.line_group_id) ?? "-",
      actName: a.act_name,
      durationMinutes: a.duration_minutes,
      occurWhen: formatProcessWhen(a.occur_week as ProcessWeekRef, a.occur_dow, a.occur_time),
      checkWhen: formatProcessWhen(a.check_week as ProcessWeekRef, a.check_dow, a.check_time),
      pointCheck: a.point_check,
      pointAdvantage: a.point_advantage,
      pointPenalty: a.point_penalty,
      crewReactionLabel: PROCESS_ACT_TYPE_LABEL[a.act_type as ProcessActType] ?? a.act_type,
      cafeLabel: PROCESS_CAFE_LABEL[a.cafe as ProcessCafe] ?? a.cafe,
      isCheckTarget: a.check_target === "check",
      status: st.status,
      reviewLink: st.reviewLink,
      scheduledCheckAt: st.scheduledCheckAt,
      requestedAt: st.requestedAt,
      completedAt: st.completedAt,
      checkedCrewCount: st.checkedCrewCount,
    };
  });

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
      hasApplied: appliedCount > 0,
    });
  }

  const targetActs = flatActs.filter((x) => x.isCheckTarget);
  const actTotal = targetActs.length;
  const actApplied = targetActs.filter((x) => applied(x.status)).length;
  const actCompleted = targetActs.filter((x) => x.status === "completed").length;
  const summary: ProcessCheckSummary = {
    lineGroupTotal: lineGroups.length,
    lineGroupApplied: lineGroups.filter((g) => g.hasApplied).length,
    actTotal,
    actApplied,
    actCompleted,
    isAllCompleted: actTotal > 0 && actCompleted === actTotal,
  };

  const logs = await listProcessCheckLogs(hub, organization, week?.weekId ?? null);

  return {
    hub,
    hubLabel: PROCESS_HUB_LABEL[hub],
    organization,
    week,
    teams,
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
  line_group_name: string;
  act_name: string;
  actor_name: string;
  created_at: string;
};

// 로그창은 섹션.0(전체 팀) — 팀 필터 없이 org×hub×week 전체. 각 행은 team_name(있으면) 표시.
export async function listProcessCheckLogs(
  hub: ProcessHub,
  organization: string,
  weekId: string | null,
  limit = 200,
): Promise<ProcessCheckLogDto[]> {
  const cap = Math.min(Math.max(limit, 1), 500);
  const run = (withTeam: boolean) => {
    let q = supabaseAdmin
      .from("process_check_logs")
      .select(
        withTeam
          ? "id,action,period_label,team_name,line_group_name,act_name,actor_name,created_at"
          : "id,action,period_label,line_group_name,act_name,actor_name,created_at",
      )
      .eq("organization_slug", organization)
      .eq("hub", hub)
      .order("created_at", { ascending: false })
      .limit(cap);
    if (weekId) q = q.eq("week_id", weekId);
    return q;
  };
  let { data, error } = await run(true);
  // team_name 컬럼(v3) 미적용 환경이면 team_name 없이 재시도(info 로그 회귀 방지).
  if (error && (error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST205")) {
    ({ data, error } = await run(false));
  }
  if (error) {
    console.warn("[process-check-logs] list unavailable:", error.message);
    return [];
  }
  const rows = ((data ?? []) as unknown as LogRow[]).map((r) => ({
    id: r.id,
    action: r.action as ProcessCheckLogAction,
    periodLabel: r.period_label,
    teamName: r.team_name ?? null, // 팀 구분 허브(experience)만 채워짐 — info 등은 null
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
  reviewLink?: unknown;
  scheduledCheckAt?: unknown;
  adminId: string;
  // 보드 조회와 동일한 주차로 저장하기 위한 스코프 모드(테스트=13주차 예외·info). 기본 operating.
  mode?: ScopeMode;
}): Promise<ProcessCheckActRowDto> {
  const { hub, organization, actId, action, adminId } = input;

  const week = await resolveCurrentWeek(hub, input.mode ?? "operating");
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
    if (!teamRow) throw new ProcessMasterError(400, "조직에 속한 활성 팀이 아닙니다");
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

  // 현재 상태 행 — 팀 구분 허브(experience)만 team_id 필터. info 는 미참조(v3 무관·회귀 금지).
  let curQuery = supabaseAdmin
    .from("process_check_statuses")
    .select("id,status,scheduled_check_at")
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId)
    .eq("act_id", actId);
  if (teamBased) {
    curQuery = teamId ? curQuery.eq("team_id", teamId) : curQuery.is("team_id", null);
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
    actName: act.act_name,
    durationMinutes: act.duration_minutes,
    occurWhen: formatProcessWhen(act.occur_week as ProcessWeekRef, act.occur_dow, act.occur_time),
    checkWhen: formatProcessWhen(act.check_week as ProcessWeekRef, act.check_dow, act.check_time),
    pointCheck: act.point_check,
    pointAdvantage: act.point_advantage,
    pointPenalty: act.point_penalty,
    crewReactionLabel: PROCESS_ACT_TYPE_LABEL[act.act_type as ProcessActType] ?? act.act_type,
    cafeLabel: PROCESS_CAFE_LABEL[act.cafe as ProcessCafe] ?? act.cafe,
    isCheckTarget: true,
    status: st.status,
    reviewLink: st.review_link,
    scheduledCheckAt: st.scheduled_check_at,
    requestedAt: st.requested_at,
    completedAt: st.completed_at,
    checkedCrewCount: st.checked_crew_count,
  };
}

async function insertProcessCheckLog(input: {
  organization: string;
  hub: ProcessHub;
  weekId: string;
  teamId: string | null;
  teamName: string | null;
  actId: string;
  lineGroupId: string;
  action: ProcessCheckLogAction;
  periodLabel: string;
  lineGroupName: string;
  actName: string;
  adminId: string;
}): Promise<void> {
  try {
    let actorName = "관리자";
    const { data: prof } = await supabaseAdmin
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", input.adminId)
      .maybeSingle();
    const dn = (prof as { display_name: string | null } | null)?.display_name?.trim();
    if (dn) actorName = dn;

    const { error } = await supabaseAdmin.from("process_check_logs").insert({
      organization_slug: input.organization,
      hub: input.hub,
      week_id: input.weekId,
      // 팀 구분 허브만 team 필드 기입(info 등은 컬럼 미참조 — v3 무관·로그 회귀 방지).
      ...(input.teamId || input.teamName ? { team_id: input.teamId, team_name: input.teamName } : {}),
      act_id: input.actId,
      line_group_id: input.lineGroupId,
      action: input.action,
      period_label: input.periodLabel,
      line_group_name: input.lineGroupName,
      act_name: input.actName,
      actor_name: actorName,
    });
    if (error) console.warn("[process-check-logs] insert skipped:", error.message);
  } catch (e) {
    console.warn("[process-check-logs] insert failed:", e instanceof Error ? e.message : e);
  }
}
