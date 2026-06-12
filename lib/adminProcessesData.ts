// Server-only data layer for process master (라인급 + 액트) — additive 마스터 카탈로그 Phase.
//
// 본 모듈은 process_line_groups · process_acts 두 테이블만 읽고 쓴다. 기존 SoT(cluster4_lines ·
// user_weekly_points · weeks · snapshot 경로), 주차 성장 계산, checkGate 판정은 일절 참조/수정하지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  PROCESS_HUB_LABEL,
  PROCESS_LINE_GROUP_MAX,
  isProcessHub,
  isProcessWeekRef,
  type ProcessActCreateInput,
  type ProcessActDto,
  type ProcessCafe,
  type ProcessCheckTarget,
  type ProcessActType,
  type ProcessHub,
  type ProcessLineGroupCreateInput,
  type ProcessLineGroupDto,
  type ProcessWeekRef,
} from "@/lib/adminProcessesTypes";

export class ProcessMasterError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// PGRST205/204 = 테이블·컬럼 미존재 — 마이그레이션 미적용 안내.
function migrationHint(error: { code?: string } | null): ProcessMasterError | null {
  const code = error?.code;
  if (code === "PGRST205" || code === "PGRST204") {
    return new ProcessMasterError(
      500,
      "process_line_groups/process_acts 스키마가 없습니다. db/migrations/2026-06-12_process_acts.sql 을 SQL Editor 에서 적용해주세요.",
    );
  }
  return null;
}

// ── 라인급 ──────────────────────────────────────────────────────────────────
type LineGroupRow = {
  id: string;
  hub: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const LINE_GROUP_SELECT =
  "id,hub,name,sort_order,is_active,created_by,created_at,updated_at";

function lineGroupToDto(row: LineGroupRow, actCount: number): ProcessLineGroupDto {
  const hub: ProcessHub = isProcessHub(row.hub) ? row.hub : "club";
  return {
    id: row.id,
    hub,
    hubLabel: PROCESS_HUB_LABEL[hub],
    name: row.name,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    actCount,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 허브별 라인급 목록 + 각 라인급 산하 액트 수(삭제 가능 판정용).
export async function listProcessLineGroups(
  hub: ProcessHub,
): Promise<ProcessLineGroupDto[]> {
  const { data, error } = await supabaseAdmin
    .from("process_line_groups")
    .select(LINE_GROUP_SELECT)
    .eq("hub", hub)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }
  const rows = (data ?? []) as unknown as LineGroupRow[];
  if (rows.length === 0) return [];

  // 산하 액트 수 — line_group_id 별 카운트. 단순 in() 조회 후 집계(라인급 ≤ 12개).
  const ids = rows.map((r) => r.id);
  const { data: actRows, error: actErr } = await supabaseAdmin
    .from("process_acts")
    .select("line_group_id")
    .in("line_group_id", ids);
  if (actErr) {
    throw migrationHint(actErr) ?? new ProcessMasterError(500, actErr.message);
  }
  const counts = new Map<string, number>();
  for (const a of (actRows ?? []) as { line_group_id: string }[]) {
    counts.set(a.line_group_id, (counts.get(a.line_group_id) ?? 0) + 1);
  }
  return rows.map((r) => lineGroupToDto(r, counts.get(r.id) ?? 0));
}

export async function createProcessLineGroup(
  input: ProcessLineGroupCreateInput,
  actorAdminId: string,
): Promise<ProcessLineGroupDto> {
  // 허브당 최대 12개 — 현재 개수 확인.
  const { count, error: countErr } = await supabaseAdmin
    .from("process_line_groups")
    .select("*", { count: "exact", head: true })
    .eq("hub", input.hub);
  if (countErr) {
    throw migrationHint(countErr) ?? new ProcessMasterError(500, countErr.message);
  }
  if ((count ?? 0) >= PROCESS_LINE_GROUP_MAX) {
    throw new ProcessMasterError(
      409,
      `${PROCESS_HUB_LABEL[input.hub]} 허브의 라인급은 최대 ${PROCESS_LINE_GROUP_MAX}개까지 등록할 수 있습니다`,
    );
  }

  const { data, error } = await supabaseAdmin
    .from("process_line_groups")
    .insert({
      hub: input.hub,
      name: input.name,
      sort_order: count ?? 0,
      created_by: actorAdminId,
    })
    .select(LINE_GROUP_SELECT)
    .single();
  if (error || !data) {
    const hint = migrationHint(error);
    if (hint) throw hint;
    // 23505 = UNIQUE(hub, name) 위반.
    if ((error as { code?: string } | null)?.code === "23505") {
      throw new ProcessMasterError(409, "이미 등록된 라인급명입니다");
    }
    throw new ProcessMasterError(500, error?.message ?? "Failed to create line group");
  }
  return lineGroupToDto(data as unknown as LineGroupRow, 0);
}

export async function deleteProcessLineGroup(id: string): Promise<void> {
  // 산하 액트 존재 검사 — 있으면 삭제 차단(시안 팝업 문구).
  const { count, error: countErr } = await supabaseAdmin
    .from("process_acts")
    .select("*", { count: "exact", head: true })
    .eq("line_group_id", id);
  if (countErr) {
    throw migrationHint(countErr) ?? new ProcessMasterError(500, countErr.message);
  }
  if ((count ?? 0) > 0) {
    throw new ProcessMasterError(
      409,
      "산하 등록된 액트가 존재합니다. 산하 등록된 액트가 없어야, 이 라인 급을 삭제할 수 있습니다. 액트 삭제는 통합 > 허브별 프로세스 > 프로세스 정보 에서 진행해주세요.",
    );
  }

  const { data, error } = await supabaseAdmin
    .from("process_line_groups")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }
  if (!data || data.length === 0) {
    throw new ProcessMasterError(404, "line group not found");
  }
}

// ── 액트 ────────────────────────────────────────────────────────────────────
type ActRow = {
  id: string;
  line_group_id: string;
  hub: string;
  act_name: string;
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
  cafe: string;
  check_target: string;
  act_type: string;
  overview: string | null;
  remarks: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const ACT_SELECT =
  "id,line_group_id,hub,act_name,duration_minutes,occur_week,occur_dow,occur_time,check_week,check_dow,check_time,point_check,point_advantage,point_penalty,cafe,check_target,act_type,overview,remarks,is_active,created_by,created_at,updated_at";

function actToDto(row: ActRow, lineGroupName: string | null): ProcessActDto {
  const hub: ProcessHub = isProcessHub(row.hub) ? row.hub : "club";
  const occurWeek: ProcessWeekRef = isProcessWeekRef(row.occur_week) ? row.occur_week : "N";
  const checkWeek: ProcessWeekRef = isProcessWeekRef(row.check_week) ? row.check_week : "N";
  return {
    id: row.id,
    lineGroupId: row.line_group_id,
    lineGroupName,
    hub,
    hubLabel: PROCESS_HUB_LABEL[hub],
    actName: row.act_name,
    durationMinutes: row.duration_minutes,
    occurWeek,
    occurDow: row.occur_dow,
    occurTime: row.occur_time,
    checkWeek,
    checkDow: row.check_dow,
    checkTime: row.check_time,
    pointCheck: row.point_check,
    pointAdvantage: row.point_advantage,
    pointPenalty: row.point_penalty,
    cafe: (row.cafe === "occur" ? "occur" : "none") as ProcessCafe,
    checkTarget: (row.check_target === "check" ? "check" : "none") as ProcessCheckTarget,
    actType: row.act_type as ProcessActType,
    overview: row.overview,
    remarks: row.remarks,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 허브별 액트 목록(소속 라인급명 포함).
export async function listProcessActs(hub: ProcessHub): Promise<ProcessActDto[]> {
  const { data, error } = await supabaseAdmin
    .from("process_acts")
    .select(ACT_SELECT)
    .eq("hub", hub)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }
  const rows = (data ?? []) as unknown as ActRow[];
  if (rows.length === 0) return [];

  // 라인급명 매핑.
  const groupIds = Array.from(new Set(rows.map((r) => r.line_group_id)));
  const { data: groups, error: gErr } = await supabaseAdmin
    .from("process_line_groups")
    .select("id,name")
    .in("id", groupIds);
  if (gErr) {
    throw migrationHint(gErr) ?? new ProcessMasterError(500, gErr.message);
  }
  const nameById = new Map<string, string>();
  for (const g of (groups ?? []) as { id: string; name: string }[]) {
    nameById.set(g.id, g.name);
  }
  return rows.map((r) => actToDto(r, nameById.get(r.line_group_id) ?? null));
}

export async function createProcessAct(
  input: ProcessActCreateInput,
  actorAdminId: string,
): Promise<ProcessActDto> {
  // 소속 라인급 존재 + hub 일치 검증.
  const { data: group, error: gErr } = await supabaseAdmin
    .from("process_line_groups")
    .select("id,hub,name")
    .eq("id", input.lineGroupId)
    .maybeSingle();
  if (gErr) {
    throw migrationHint(gErr) ?? new ProcessMasterError(500, gErr.message);
  }
  if (!group) {
    throw new ProcessMasterError(400, "선택한 라인급을 찾을 수 없습니다");
  }
  if ((group as { hub: string }).hub !== input.hub) {
    throw new ProcessMasterError(400, "라인급의 소속 허브와 액트의 허브가 일치하지 않습니다");
  }

  const { data, error } = await supabaseAdmin
    .from("process_acts")
    .insert({
      line_group_id: input.lineGroupId,
      hub: input.hub,
      act_name: input.actName,
      duration_minutes: input.durationMinutes,
      occur_week: input.occurWeek,
      occur_dow: input.occurDow,
      occur_time: input.occurTime,
      check_week: input.checkWeek,
      check_dow: input.checkDow,
      check_time: input.checkTime,
      point_check: input.pointCheck,
      point_advantage: input.pointAdvantage,
      point_penalty: input.pointPenalty,
      cafe: input.cafe,
      check_target: input.checkTarget,
      act_type: input.actType,
      overview: input.overview,
      remarks: input.remarks,
      created_by: actorAdminId,
    })
    .select(ACT_SELECT)
    .single();
  if (error || !data) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error?.message ?? "Failed to create act");
  }
  return actToDto(data as unknown as ActRow, (group as { name: string }).name);
}
