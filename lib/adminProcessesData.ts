// Server-only data layer for process master (라인급 + 액트) — additive 마스터 카탈로그 Phase.
//
// 본 모듈은 process_line_groups · process_acts 두 테이블만 읽고 쓴다. 기존 SoT(cluster4_lines ·
// user_weekly_points · weeks · snapshot 경로), 주차 성장 계산, checkGate 판정은 일절 참조/수정하지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  PROCESS_HUB_LABEL,
  PROCESS_LINE_GROUP_MAX,
  computeProcessActSummary,
  enforcePointC,
  isProcessHub,
  isProcessLineGroupScope,
  isProcessWeekRef,
  type ProcessActCreateInput,
  type ProcessActDto,
  type ProcessCafe,
  type ProcessCheckTarget,
  type ProcessActType,
  type ProcessHub,
  type ProcessInfoResult,
  type ProcessLineGroupCreateInput,
  type ProcessLineGroupDto,
  type ProcessLineGroupScope,
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
  scope_type?: string | null; // 마이그 미적용(pre-migration) 시 미존재 — 폴백으로 이름 파생.
  sort_order: number;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const LINE_GROUP_SELECT =
  "id,hub,name,scope_type,sort_order,is_active,created_by,created_at,updated_at";
// scope_type 컬럼 미적용 스키마(구 배포) 대비 폴백 SELECT.
const LINE_GROUP_SELECT_LEGACY =
  "id,hub,name,sort_order,is_active,created_by,created_at,updated_at";

// scope_type 컬럼 존재 여부 프로브(1회 캐시) — 마이그레이션 미적용 스키마에서 42703 회피.
let _scopeColumnAvailable: boolean | null = null;
async function scopeTypeColumnAvailable(): Promise<boolean> {
  if (_scopeColumnAvailable !== null) return _scopeColumnAvailable;
  const { error } = await supabaseAdmin
    .from("process_line_groups")
    .select("scope_type")
    .limit(1);
  // 42703=undefined column · PGRST204=컬럼 스키마 캐시 미반영. 그 외(테이블 자체 부재 등)는 상위에서 처리.
  _scopeColumnAvailable = !(error && (error.code === "42703" || error.code === "PGRST204"));
  return _scopeColumnAvailable;
}

// 저장된 scope_type 우선. 미존재(pre-migration)면 백필과 동일 규칙으로 파생(experience+이름"파트"→PART).
//   ⚠ 이름 파생은 컬럼 미적용 기간 한정 폴백이다 — 마이그 적용 후에는 저장값만 사용(이 분기 도달 안 함).
function resolveLineGroupScope(scopeRaw: unknown, hub: ProcessHub, name: string): ProcessLineGroupScope {
  if (isProcessLineGroupScope(scopeRaw)) return scopeRaw;
  return hub === "experience" && name.includes("파트") ? "PART" : "TEAM";
}

function lineGroupToDto(row: LineGroupRow, actCount: number): ProcessLineGroupDto {
  const hub: ProcessHub = isProcessHub(row.hub) ? row.hub : "club";
  return {
    id: row.id,
    hub,
    hubLabel: PROCESS_HUB_LABEL[hub],
    name: row.name,
    scopeType: resolveLineGroupScope(row.scope_type, hub, row.name),
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
  const scopeAvail = await scopeTypeColumnAvailable();
  const { data, error } = await supabaseAdmin
    .from("process_line_groups")
    .select(scopeAvail ? LINE_GROUP_SELECT : LINE_GROUP_SELECT_LEGACY)
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

  // 파트 전용('PART')은 팀 구분 허브(experience)에서만 허용 — 그 외 허브는 'TEAM' 강제(프론트 우회 방어).
  const scopeType: ProcessLineGroupScope =
    input.scopeType === "PART" && input.hub === "experience" ? "PART" : "TEAM";
  const scopeAvail = await scopeTypeColumnAvailable();
  // 컬럼 미적용 스키마인데 파트 전용을 요청하면 저장 불가 → 명확히 차단(이름 추론으로 우회 금지).
  if (scopeType === "PART" && !scopeAvail) {
    throw new ProcessMasterError(
      500,
      "파트 전용 저장에는 scope_type 컬럼이 필요합니다. db/migrations/2026-07-24_process_line_group_scope_type.sql 을 적용해주세요.",
    );
  }

  const { data, error } = await supabaseAdmin
    .from("process_line_groups")
    .insert({
      hub: input.hub,
      name: input.name,
      ...(scopeAvail ? { scope_type: scopeType } : {}),
      sort_order: count ?? 0,
      created_by: actorAdminId,
    })
    .select(scopeAvail ? LINE_GROUP_SELECT : LINE_GROUP_SELECT_LEGACY)
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

// 전체 허브 액트 목록(소속 라인급명 포함) — 프로세스 관리 화면의 단일 표용.
// 허브 필터 없이 process_acts 전체를 조회한다. 각 행에 hub/hubLabel 이 포함된다.
export async function listAllProcessActs(): Promise<ProcessActDto[]> {
  const { data, error } = await supabaseAdmin
    .from("process_acts")
    .select(ACT_SELECT)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true });
  if (error) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }
  const rows = (data ?? []) as unknown as ActRow[];
  if (rows.length === 0) return [];

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
      // 액트 종류(act_type)이 '필수'가 아니면 포인트 C(penalty)=0 강제(프론트 우회·잘못된 요청 보정).
      point_penalty: enforcePointC(input.actType, input.pointPenalty),
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

export async function deleteProcessAct(id: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("process_acts")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }
  if (!data || data.length === 0) {
    throw new ProcessMasterError(404, "act not found");
  }
}

// ── 프로세스 정보(/admin/processes/info) — 허브별 액트 목록 + 요약 ──────────
export async function getProcessInfo(hub: ProcessHub): Promise<ProcessInfoResult> {
  const [acts, groups] = await Promise.all([
    listProcessActs(hub),
    listProcessLineGroups(hub),
  ]);
  const summary = computeProcessActSummary(acts, groups.length);
  return { hub, hubLabel: PROCESS_HUB_LABEL[hub], acts, summary };
}

// 프로세스 관리(전체 허브) — 모든 허브의 액트 목록 + 전역 요약.
//   요약은 전체 허브 액트/라인급을 합산한 글로벌 값(누적계층 계산은 허브별과 동일).
export async function getProcessInfoAll(): Promise<ProcessInfoResult> {
  const acts = await listAllProcessActs();
  const { count, error } = await supabaseAdmin
    .from("process_line_groups")
    .select("*", { count: "exact", head: true });
  if (error) {
    throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  }
  const summary = computeProcessActSummary(acts, count ?? 0);
  return { hub: "club", hubLabel: "전체", acts, summary };
}
