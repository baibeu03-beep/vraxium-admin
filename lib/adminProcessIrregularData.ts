// Server-only data layer for 변동 액트 (/admin/processes/check/irregular).
//
// process_irregular_acts (org × week × 대상고객 단위 변동 액트 인스턴스) 읽기·쓰기.
//   - 신청자 = 운영진(admin_users) / 대상자 = 고객앱 사용자(user_profiles).
//   - org + test/operating 모드 분리는 target_user_id 기준(resolveUserScope · test_user_markers SoT).
//   - 주차 = 프로세스 체크 공용 SoT(resolveProcessWeek) 재사용(운영=현재 / 테스트=마지막 활동주차 walk-back).
//   - ⚠ user_weekly_points · 주차 성장 계산 · snapshot · checkGate · demoUserId 무접촉.
//     point A/B/C 는 표시/관리용 정의값(고객앱 점수 미연동).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import { resolveProcessWeek } from "@/lib/adminProcessCheckData";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import { accrueForCompletedIrregular, revokeForAct } from "@/lib/processPointAccrual";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  IRREGULAR_ACT_NAME_MAX,
  IRREGULAR_CREW_REACTION_DEFAULT,
  IRREGULAR_CREW_REACTION_LABEL,
  IRREGULAR_KIND_LABEL,
  coerceIrregularCrewReaction,
  irregularCafeLabel,
  isIrregularCrewReaction,
  isIrregularDuration,
  isIrregularKind,
  isIrregularPoint,
  isIrregularPointMode,
  normalizeIrregularPoints,
  validateReviewLink,
  validateScheduledCheckAt,
  type IrregularCrewReaction,
  type IrregularKind,
  type IrregularPointMode,
  type IrregularStatus,
  type IrregularTargetUserDto,
  type ProcessIrregularActRowDto,
  type ProcessIrregularBoardDto,
  type ProcessIrregularSummary,
} from "@/lib/adminProcessIrregularTypes";

// 변동 액트는 info 와 동일한 주차 정책(테스트=휴식꼬리→마지막 활동주차) 적용.
//   공통 SoT 의 "process-irregular" hub 키로 위임(허용 정책은 cluster4TestWeekPolicy 단일 출처).
const IRREGULAR_TEST_WEEK_HUB = "process-irregular" as const;

function migrationHint(error: { code?: string } | null): ProcessMasterError | null {
  const code = error?.code;
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01") {
    return new ProcessMasterError(
      500,
      "process_irregular_acts 스키마가 없습니다. db/migrations/2026-06-15_process_irregular_acts.sql 을 SQL Editor 에서 적용해주세요.",
    );
  }
  return null;
}

type IrregularRow = {
  id: string;
  kind: string;
  act_name: string;
  applicant_admin_name: string;
  target_user_id: string | null;
  target_user_name: string | null;
  duration_minutes: number | null;
  reason: string | null;
  point_a: number;
  point_b: number;
  point_c: number;
  crew_reaction: string;
  review_link: string | null;
  scheduled_check_at: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
  attempt_count: number | null;
  last_error: string | null;
};

const ROW_SELECT =
  "id,kind,act_name,applicant_admin_name,target_user_id,target_user_name,duration_minutes,reason,point_a,point_b,point_c,crew_reaction,review_link,scheduled_check_at,status,completed_at,created_at,attempt_count,last_error";

type RecipientRow = {
  user_id: string | null;
  nickname: string;
  match_type: string;
  match_reason: string | null;
};

function toRowDto(
  r: IrregularRow,
  recipientsByRef: Map<string, RecipientRow[]> = new Map(),
): ProcessIrregularActRowDto {
  const kind: IrregularKind = r.kind === "manual_grant" ? "manual_grant" : "review_request";
  const status: IrregularStatus = r.status === "completed" ? "completed" : "pending";
  // 레거시(required|optional|selection|none) 값도 신규 2종(전원/부분)으로만 표시.
  const crew: IrregularCrewReaction = coerceIrregularCrewReaction(r.crew_reaction);
  const recs = (recipientsByRef.get(r.id) ?? []).map((rc) => ({
    userId: rc.user_id,
    nickname: rc.nickname,
    matchType: rc.match_type === "matched" ? ("matched" as const) : ("review" as const),
    matchReason: rc.match_reason,
  }));
  return {
    id: r.id,
    kind,
    kindLabel: IRREGULAR_KIND_LABEL[kind],
    cafeLabel: irregularCafeLabel(kind),
    actName: r.act_name,
    applicantAdminName: r.applicant_admin_name,
    targetUserId: r.target_user_id,
    targetUserName: r.target_user_name,
    durationMinutes: r.duration_minutes,
    reason: r.reason,
    pointA: r.point_a,
    pointB: r.point_b,
    pointC: r.point_c,
    crewReaction: crew,
    crewReactionLabel: IRREGULAR_CREW_REACTION_LABEL[crew],
    reviewLink: r.review_link,
    scheduledCheckAt: r.scheduled_check_at,
    status,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    recipients: recs,
    matchedCount: recs.filter((x) => x.matchType === "matched").length,
    attemptCount: r.attempt_count ?? 0,
    lastError: r.last_error,
  };
}

// 보드 행들의 크루 식별 결과(recipients)를 한 번에 로드 → ref_id 별 맵.
async function loadRecipientsByRef(refIds: string[]): Promise<Map<string, RecipientRow[]>> {
  const map = new Map<string, RecipientRow[]>();
  if (refIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("process_check_review_recipients")
    .select("ref_id,user_id,nickname,match_type,match_reason")
    .eq("source", "irregular")
    .in("ref_id", refIds);
  if (error) {
    // recipients 테이블 미적용이어도 보드는 동작(빈 결과).
    console.warn("[irregular-recipients] read unavailable:", error.message);
    return map;
  }
  for (const r of (data ?? []) as Array<RecipientRow & { ref_id: string }>) {
    const arr = map.get(r.ref_id) ?? [];
    arr.push({ user_id: r.user_id, nickname: r.nickname, match_type: r.match_type, match_reason: r.match_reason });
    map.set(r.ref_id, arr);
  }
  return map;
}

function summarize(acts: ProcessIrregularActRowDto[]): ProcessIrregularSummary {
  return {
    total: acts.length,
    reviewRequest: acts.filter((a) => a.kind === "review_request").length,
    manualGrant: acts.filter((a) => a.kind === "manual_grant").length,
    completed: acts.filter((a) => a.status === "completed").length,
    pending: acts.filter((a) => a.status === "pending").length,
  };
}

// ── 보드 조회 (org × week × 대상고객 스코프) ───────────────────────────────────
export async function getIrregularBoard(
  organization: string,
  mode: ScopeMode = "operating",
): Promise<ProcessIrregularBoardDto> {
  const week = await resolveProcessWeek(mode, IRREGULAR_TEST_WEEK_HUB);
  if (!week?.weekId) {
    return { organization, week, summary: summarize([]), acts: [] };
  }

  // 스코프 분기 = 행에 기록된 scope_mode(operating/test). review_request 는 대상자 미선택(null)
  //   이라 target 기준 필터 불가 → 생성 시 보드 모드를 그대로 박은 scope_mode 로 분리한다.
  const { data, error } = await supabaseAdmin
    .from("process_irregular_acts")
    .select(ROW_SELECT)
    .eq("organization_slug", organization)
    .eq("week_id", week.weekId)
    .eq("scope_mode", mode)
    .order("created_at", { ascending: false });
  if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);

  const rows = (data ?? []) as IrregularRow[];
  const recipients = await loadRecipientsByRef(rows.map((r) => r.id));
  const acts = rows.map((r) => toRowDto(r, recipients));

  return { organization, week, summary: summarize(acts), acts };
}

// ── 대상 고객 검색 (스코프 적용) ───────────────────────────────────────────────
export async function searchIrregularTargets(
  organization: string,
  mode: ScopeMode,
  rawQuery: string,
): Promise<IrregularTargetUserDto[]> {
  const q = rawQuery.trim();
  if (!q) return [];
  const scope = await resolveUserScope(mode, organization as OrganizationSlug);

  let query = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,auth_email,contact_email")
    .eq("organization_slug", organization)
    .limit(20);
  // test 모드는 화이트리스트(테스트 유저)로 좁혀 비용 절감.
  if (mode === "test") {
    const ids = scope.includeUserIds ?? [];
    if (ids.length === 0) return [];
    query = query.in("user_id", ids);
  }
  // uuid 면 정확 매칭, 아니면 이름/이메일 부분 검색.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_RE.test(q)) {
    query = query.eq("user_id", q);
  } else {
    const esc = q.replace(/[%,]/g, " ");
    query = query.or(
      [`display_name.ilike.%${esc}%`, `auth_email.ilike.%${esc}%`, `contact_email.ilike.%${esc}%`].join(","),
    );
  }
  const { data, error } = await query;
  if (error) {
    console.warn("[irregular-targets] search unavailable:", error.message);
    return [];
  }
  type UPRow = {
    user_id: string;
    display_name: string | null;
    auth_email: string | null;
    contact_email: string | null;
  };
  return ((data ?? []) as UPRow[])
    .filter((r) => scope.includes(r.user_id)) // operating: 테스트 유저 제외 보강
    .map((r) => ({
      userId: r.user_id,
      displayName: r.display_name ?? "(이름 없음)",
      authEmail: r.auth_email,
      contactEmail: r.contact_email,
    }));
}

// ── 공통 필드 파싱(검수 신청·수동 부여 공용) ──────────────────────────────────
function parseCommonFields(input: {
  actName: unknown;
  durationMinutes?: unknown;
  reason?: unknown;
  pointA?: unknown;
  pointB?: unknown;
  pointC?: unknown;
  crewReaction?: unknown;
  pointMode?: unknown;
}) {
  if (typeof input.actName !== "string" || !input.actName.trim()) {
    throw new ProcessMasterError(400, "액트명(act_name)은 필수입니다");
  }
  const actName = input.actName.trim();
  if (actName.length > IRREGULAR_ACT_NAME_MAX) {
    throw new ProcessMasterError(400, `액트명은 최대 ${IRREGULAR_ACT_NAME_MAX}자입니다`);
  }
  let durationMinutes: number | null = null;
  if (input.durationMinutes !== undefined && input.durationMinutes !== null && input.durationMinutes !== "") {
    const d = Number(input.durationMinutes);
    if (!isIrregularDuration(d)) throw new ProcessMasterError(400, "소요 시간은 1~600분(정수)이어야 합니다");
    durationMinutes = d;
  }
  const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null;
  const pointA = Number(input.pointA ?? 0);
  const pointB = Number(input.pointB ?? 0);
  const pointC = Number(input.pointC ?? 0);
  const crewReaction: IrregularCrewReaction = isIrregularCrewReaction(input.crewReaction)
    ? input.crewReaction
    : IRREGULAR_CREW_REACTION_DEFAULT;
  const pointMode: IrregularPointMode | null = isIrregularPointMode(input.pointMode) ? input.pointMode : null;
  // 포인트 정규화(단일 SoT) — 전원=A/B/C 자유 / 부분=ab(C강제0) | c(A·B강제0). 부분+방식없음=거부.
  //   ⚠ 프론트 우회·API 직접호출도 이 지점에서 차단(UI 검증과 별개로 백엔드 강제).
  const norm = normalizeIrregularPoints(crewReaction, pointMode, pointA, pointB, pointC);
  if (!norm.ok) throw new ProcessMasterError(400, norm.error);
  return {
    actName,
    durationMinutes,
    reason,
    pointA: norm.pointA,
    pointB: norm.pointB,
    pointC: norm.pointC,
    crewReaction,
  };
}

// ── 검수 신청(review_request) 생성 — 대상자 미선택·pending(worker 가 사후 식별/완료) ──────
export async function createIrregularAct(input: {
  organization: string;
  mode: ScopeMode;
  adminId: string;
  kind: unknown;
  actName: unknown;
  targetUserId?: unknown; // (호환용 — review_request 는 항상 미저장)
  durationMinutes?: unknown;
  reason?: unknown;
  pointA?: unknown;
  pointB?: unknown;
  pointC?: unknown;
  crewReaction?: unknown;
  pointMode?: unknown;
  reviewLink?: unknown;
  scheduledCheckAt?: unknown;
}): Promise<ProcessIrregularActRowDto> {
  const { organization, mode, adminId } = input;
  if (input.kind !== "review_request") {
    throw new ProcessMasterError(400, "이 경로는 검수 신청(review_request) 전용입니다");
  }
  const common = parseCommonFields(input);

  // 검수 링크(필수·http) + 검수 시점(필수·now<.<=now+7d).
  let reviewLink: string | null = null;
  if (typeof input.reviewLink === "string" && input.reviewLink.trim()) {
    const link = validateReviewLink(input.reviewLink);
    if (!link.ok) throw new ProcessMasterError(400, link.error);
    reviewLink = link.value;
  }
  if (!reviewLink) throw new ProcessMasterError(400, "검수 신청은 검수 링크가 필수입니다");

  const week = await resolveProcessWeek(mode, IRREGULAR_TEST_WEEK_HUB);
  if (!week?.weekId) {
    throw new ProcessMasterError(400, "현재 주차(weeks 행)를 찾을 수 없어 변동 액트를 저장할 수 없습니다");
  }

  const nowMs = Date.now();
  let scheduledCheckAt: string | null = null;
  if (typeof input.scheduledCheckAt === "string" && input.scheduledCheckAt.trim()) {
    const sched = validateScheduledCheckAt(input.scheduledCheckAt, nowMs);
    if (!sched.ok) throw new ProcessMasterError(400, sched.error);
    scheduledCheckAt = new Date(input.scheduledCheckAt).toISOString();
  }
  if (!scheduledCheckAt) throw new ProcessMasterError(400, "검수 신청은 검수 시점이 필수입니다");

  const applicantAdminName = await resolveAdminName(adminId);
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("process_irregular_acts")
    .insert({
      organization_slug: organization,
      week_id: week.weekId,
      kind: "review_request",
      act_name: common.actName,
      applicant_admin_id: adminId,
      applicant_admin_name: applicantAdminName,
      target_user_id: null,
      target_user_name: null,
      scope_mode: mode,
      duration_minutes: common.durationMinutes,
      reason: common.reason,
      point_a: common.pointA,
      point_b: common.pointB,
      point_c: common.pointC,
      crew_reaction: common.crewReaction,
      review_link: reviewLink,
      scheduled_check_at: scheduledCheckAt,
      status: "pending",
      completed_at: null,
    })
    .select(ROW_SELECT)
    .single();
  if (insErr) throw migrationHint(insErr) ?? new ProcessMasterError(500, insErr.message);
  return toRowDto(inserted as IrregularRow);
}

// ── 수동 부여(manual_grant) 생성 — 대상 크루 명단(복수)·생성 즉시 completed(created==completed) ──
//   검수 링크/시점 없음. 크루는 org+mode 스코프 전원 통과(fail-closed) → recipients(matched) 저장.
export async function createManualGrant(input: {
  organization: string;
  mode: ScopeMode;
  adminId: string;
  actName: unknown;
  targetUserIds: unknown; // string[] — 대상 크루 user_id 명단
  durationMinutes?: unknown;
  reason?: unknown;
  pointA?: unknown;
  pointB?: unknown;
  pointC?: unknown;
  crewReaction?: unknown;
  pointMode?: unknown;
}): Promise<ProcessIrregularActRowDto> {
  const { organization, mode, adminId } = input;
  // 수동 부여는 '전원' 선택 불가 — 항상 '부분'(포인트 방식 ab|c 택1)만 가능.
  if (input.crewReaction === "all") {
    throw new ProcessMasterError(400, "수동 부여는 '전원'을 선택할 수 없습니다(부분만 가능)");
  }
  const common = parseCommonFields({ ...input, crewReaction: "partial" });

  // 대상 크루 명단 — 비어 있으면 거부.
  const ids = Array.isArray(input.targetUserIds)
    ? Array.from(new Set(input.targetUserIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0)))
    : [];
  if (ids.length === 0) throw new ProcessMasterError(400, "수동 부여는 대상 크루를 1명 이상 선택해야 합니다");

  // org + mode 스코프 전원 검증(fail-closed 422) + 소속/이름 확정.
  const scope = await resolveUserScope(mode, organization as OrganizationSlug);
  assertUserIdsInScope(scope, ids);
  const { data: profs, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", ids);
  if (pErr) throw new ProcessMasterError(500, pErr.message);
  const rows = (profs ?? []) as Array<{ user_id: string; display_name: string | null; organization_slug: string | null }>;
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) throw new ProcessMasterError(404, "대상 크루(user_profiles)를 찾을 수 없습니다");
    if (p.organization_slug !== organization) {
      throw new ProcessMasterError(422, "대상 크루가 해당 조직(org) 소속이 아닙니다");
    }
  }

  const week = await resolveProcessWeek(mode, IRREGULAR_TEST_WEEK_HUB);
  if (!week?.weekId) {
    throw new ProcessMasterError(400, "현재 주차(weeks 행)를 찾을 수 없어 변동 액트를 저장할 수 없습니다");
  }

  // created == completed (사람이 이미 검수 완료) — 검수 링크/시점 없음.
  const nowIso = new Date().toISOString();
  const applicantAdminName = await resolveAdminName(adminId);
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("process_irregular_acts")
    .insert({
      organization_slug: organization,
      week_id: week.weekId,
      kind: "manual_grant",
      act_name: common.actName,
      applicant_admin_id: adminId,
      applicant_admin_name: applicantAdminName,
      target_user_id: null,
      target_user_name: null,
      scope_mode: mode,
      duration_minutes: common.durationMinutes,
      reason: common.reason,
      point_a: common.pointA,
      point_b: common.pointB,
      point_c: common.pointC,
      crew_reaction: common.crewReaction,
      review_link: null,
      scheduled_check_at: nowIso, // 신청 시점 == 검수 시점(개념)
      status: "completed",
      completed_at: nowIso,
    })
    .select(ROW_SELECT)
    .single();
  if (insErr) throw migrationHint(insErr) ?? new ProcessMasterError(500, insErr.message);
  const act = inserted as IrregularRow;

  // 대상 크루 명단 → recipients(matched). user_weekly_points/snapshot 무접촉.
  const recRows = ids.map((id) => ({
    source: "irregular",
    ref_id: act.id,
    organization_slug: organization,
    scope_mode: mode,
    user_id: id,
    nickname: byId.get(id)?.display_name?.trim() || "(이름 없음)",
    match_type: "matched",
    match_reason: "manual",
  }));
  const { error: recErr } = await supabaseAdmin.from("process_check_review_recipients").insert(recRows);
  if (recErr) throw migrationHint(recErr) ?? new ProcessMasterError(500, recErr.message);

  // 포인트 적립(완료 즉시) — era 경계(operating=summer+/test=+W13)·스코프 가드는 helper 내부.
  //   best-effort: 적립 실패(마이그레이션 미적용 PGRST205 등)가 수동부여 생성을 깨뜨리지 않게 격리.
  try {
    const acc = await accrueForCompletedIrregular(act.id);
    if ("skipped" in acc && acc.skipped) {
      console.log("[accrual] manual_grant 적립 스킵", { actId: act.id, reason: acc.reason });
    }
  } catch (e) {
    console.warn("[accrual] manual_grant 적립 실패(격리·재시도 가능)", { actId: act.id, message: e instanceof Error ? e.message : String(e) });
  }

  const recipients = await loadRecipientsByRef([act.id]);
  return toRowDto(act, recipients);
}

// ── 체크 완료 처리 (review_request: pending → completed) ───────────────────────
export async function completeIrregularAct(
  id: string,
  organization: string,
  mode: ScopeMode,
): Promise<ProcessIrregularActRowDto> {
  const row = await loadScopedRow(id, organization, mode);
  if (row.status === "completed") {
    throw new ProcessMasterError(409, "이미 체크 완료된 변동 액트입니다");
  }
  const { data, error } = await supabaseAdmin
    .from("process_irregular_acts")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", id)
    .select(ROW_SELECT)
    .single();
  if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  return toRowDto(data as IrregularRow);
}

// ── 액트 종류 변경 (테이블 인라인 드롭다운) ────────────────────────────────────
export async function setIrregularCrewReaction(
  id: string,
  organization: string,
  mode: ScopeMode,
  crewReaction: unknown,
  pointMode?: unknown,
): Promise<ProcessIrregularActRowDto> {
  if (!isIrregularCrewReaction(crewReaction)) {
    throw new ProcessMasterError(400, "crew_reaction 은 all|partial 이어야 합니다");
  }
  const row = await loadScopedRow(id, organization, mode); // 존재 + org + 대상 스코프 검증
  // 수동 부여는 '전원'으로 변경 불가(부분만 가능).
  if (crewReaction === "all" && row.kind === "manual_grant") {
    throw new ProcessMasterError(400, "수동 부여는 '전원'으로 변경할 수 없습니다(부분만 가능)");
  }
  // 포인트 정규화 — 변경 결과가 정책(전원=A/B/C·부분=ab|c)을 항상 만족하도록 보정.
  //   인라인은 포인트 방식 선택 UI 가 없어 pointMode 미지정 시 기존 값으로 추론(C만 있으면 c, 그 외 ab).
  const effMode: IrregularPointMode | null =
    crewReaction === "partial"
      ? isIrregularPointMode(pointMode)
        ? pointMode
        : row.point_c > 0 && row.point_a === 0 && row.point_b === 0
          ? "c"
          : "ab"
      : null;
  const norm = normalizeIrregularPoints(crewReaction, effMode, row.point_a, row.point_b, row.point_c);
  if (!norm.ok) throw new ProcessMasterError(400, norm.error);
  const { data, error } = await supabaseAdmin
    .from("process_irregular_acts")
    .update({ crew_reaction: crewReaction, point_a: norm.pointA, point_b: norm.pointB, point_c: norm.pointC })
    .eq("id", id)
    .select(ROW_SELECT)
    .single();
  if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  return toRowDto(data as IrregularRow);
}

// ── 삭제 (관리용 — 잘못 등록한 행 제거) ────────────────────────────────────────
export async function deleteIrregularAct(
  id: string,
  organization: string,
  mode: ScopeMode,
): Promise<void> {
  await loadScopedRow(id, organization, mode); // 존재 + org + 대상 스코프 검증
  // 적립 회수 — 원장 행 제거 후 영향 사용자 user_weekly_points 재계산 + snapshot 무효화(best-effort).
  try {
    await revokeForAct("irregular", id);
  } catch (e) {
    console.warn("[accrual] 삭제 시 적립 회수 실패(격리)", { actId: id, message: e instanceof Error ? e.message : String(e) });
  }
  const { error } = await supabaseAdmin.from("process_irregular_acts").delete().eq("id", id);
  if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
}

// 단건 로드 — org + scope_mode 일치 검증(다른 org/모드 행 접근 차단).
//   scope_mode 로 분리 — review_request 는 대상자(null)라 target 기준 불가, 생성 시 박은 모드로 격리.
async function loadScopedRow(
  id: string,
  organization: string,
  mode: ScopeMode,
): Promise<IrregularRow> {
  const { data, error } = await supabaseAdmin
    .from("process_irregular_acts")
    .select(ROW_SELECT + ",organization_slug,scope_mode")
    .eq("id", id)
    .maybeSingle();
  if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
  const row = data as (IrregularRow & { organization_slug: string; scope_mode: string }) | null;
  if (!row) throw new ProcessMasterError(404, "변동 액트를 찾을 수 없습니다");
  if (row.organization_slug !== organization || row.scope_mode !== mode) {
    throw new ProcessMasterError(404, "변동 액트를 찾을 수 없습니다");
  }
  return row;
}

async function resolveAdminName(adminId: string): Promise<string> {
  try {
    const { data: prof } = await supabaseAdmin
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", adminId)
      .maybeSingle();
    const dn = (prof as { display_name: string | null } | null)?.display_name?.trim();
    if (dn) return dn;
    const { data: admin } = await supabaseAdmin
      .from("admin_users")
      .select("email")
      .eq("id", adminId)
      .maybeSingle();
    const em = (admin as { email: string | null } | null)?.email?.trim();
    if (em) return em;
  } catch {
    /* best-effort denorm */
  }
  return "관리자";
}
