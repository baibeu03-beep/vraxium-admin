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
import { describeCurrentWeek } from "@/lib/cluster4WeekPolicy";
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
async function loadProcessCheckTeams(organization: string): Promise<ProcessCheckTeamDto[]> {
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
  return ((data ?? []) as Array<{ id: string; team_name: string }>).map((t) => ({
    teamId: t.id,
    teamName: t.team_name,
    // 팀 산하 체크대상 전부 completed → 완료. 본 Phase(섹션.0·팀 스코프 상태 미저장)는 항상 체크 중.
    isAllCompleted: false,
  }));
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
async function resolveCurrentWeek(): Promise<ProcessCheckWeekDto | null> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const d = describeCurrentWeek(todayIso);
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
): Promise<Map<string, StatusState>> {
  const map = new Map<string, StatusState>();
  const { data, error } = await supabaseAdmin
    .from("process_check_statuses")
    .select(STATUS_SELECT)
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId);
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
): Promise<ProcessCheckBoardDto> {
  const week = await resolveCurrentWeek();
  const { groups, acts } = await loadActiveMaster(hub);
  const statusByAct = week?.weekId
    ? await loadStatuses(organization, hub, week.weekId)
    : new Map<string, StatusState>();
  // 팀 구분 허브면 org 팀 동적 조회(상태창1 팀별 문장). 그 외는 빈 배열(허브 전체 1문장).
  const teams = isTeamBasedProcessHub(hub) ? await loadProcessCheckTeams(organization) : [];

  const groupNameById = new Map<string, string>();
  const groupSort = new Map<string, number>();
  for (const g of groups) {
    groupNameById.set(g.id, g.name);
    groupSort.set(g.id, g.sort_order);
  }

  // [섹션.1] 액트 목록 — 발생 시점(필요) 순: occur_week(N→N+1) → occur_dow(일~토) →
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
  line_group_name: string;
  act_name: string;
  actor_name: string;
  created_at: string;
};

export async function listProcessCheckLogs(
  hub: ProcessHub,
  organization: string,
  weekId: string | null,
  limit = 200,
): Promise<ProcessCheckLogDto[]> {
  const cap = Math.min(Math.max(limit, 1), 500);
  let query = supabaseAdmin
    .from("process_check_logs")
    .select("id,action,period_label,line_group_name,act_name,actor_name,created_at")
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .order("created_at", { ascending: false })
    .limit(cap);
  if (weekId) query = query.eq("week_id", weekId);
  const { data, error } = await query;
  if (error) {
    console.warn("[process-check-logs] list unavailable:", error.message);
    return [];
  }
  const rows = ((data ?? []) as LogRow[]).map((r) => ({
    id: r.id,
    action: r.action as ProcessCheckLogAction,
    periodLabel: r.period_label,
    // 팀명은 experience 체크(섹션.1·team_name 컬럼) 도입 시 채운다. 현재는 null(experience 로그 없음).
    teamName: null,
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
  reviewLink?: unknown;
  scheduledCheckAt?: unknown;
  adminId: string;
}): Promise<ProcessCheckActRowDto> {
  const { hub, organization, actId, action, adminId } = input;

  const week = await resolveCurrentWeek();
  if (!week?.weekId) {
    throw new ProcessMasterError(400, "현재 주차(weeks 행)를 찾을 수 없어 체크를 저장할 수 없습니다");
  }
  const weekId = week.weekId;

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

  // 현재 상태 행.
  const { data: cur, error: curErr } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,status,scheduled_check_at")
    .eq("organization_slug", organization)
    .eq("hub", hub)
    .eq("week_id", weekId)
    .eq("act_id", actId)
    .maybeSingle();
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
