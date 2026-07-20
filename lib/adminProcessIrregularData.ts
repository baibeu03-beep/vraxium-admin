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
import {
  resolveProcessWeek,
  resolveProcessWeekByWeekId,
  resolveSelectableProcessWeeks,
} from "@/lib/adminProcessCheckData";
import {
  deriveCommentCollectionStatus,
  isCommentCollectionStoredStatus,
} from "@/lib/adminProcessCheckTypes";
import { uncompleteResetStamp } from "@/lib/processCheckCollectionReset";
import {
  getActiveProcessCheckExceptionWeekIds,
  hasActiveProcessCheckException,
} from "@/lib/processCheckWindowsData";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import {
  accrueForCompletedIrregular,
  isAccrualAllowedWeek,
  revokeForAct,
} from "@/lib/processPointAccrual";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  recomputeDerivedAfterActMutation,
  type RejudgeResult,
} from "@/lib/crewWeekGrowthRejudge";
import type { OrganizationSlug } from "@/lib/organizations";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  IRREGULAR_ACT_NAME_MAX,
  IRREGULAR_CREW_REACTION_DEFAULT,
  IRREGULAR_CREW_REACTION_LABEL,
  IRREGULAR_KIND_LABEL,
  coerceIrregularCrewReaction,
  effectiveIrregularStatus,
  irregularCafeLabel,
  isIrregularCrewReaction,
  isIrregularDuration,
  isIrregularPointMode,
  normalizeIrregularPoints,
  validateReviewLink,
  validateScheduledCheckAt,
  type IrregularCrewReaction,
  type IrregularKind,
  type IrregularPointMode,
  type IrregularStatus,
  type IrregularTargetUserDto,
  type ProcessCheckWeekDto,
  type ProcessIrregularActRowDto,
  type ProcessIrregularBoardDto,
  type ProcessIrregularSummary,
} from "@/lib/adminProcessIrregularTypes";

// 변동 액트는 info 와 동일한 주차 정책(테스트=휴식꼬리→마지막 활동주차) 적용.
//   공통 SoT 의 "process-irregular" hub 키로 위임(허용 정책은 cluster4TestWeekPolicy 단일 출처).
const IRREGULAR_TEST_WEEK_HUB = "process-irregular" as const;

// write 대상 주차 — 기본=현재. 선택 주차가 현재와 다르면 활성 예외(org+"irregular")일 때만 허용.
//   예외가 아니면 fail-closed(422). process_check_windows 단일 SoT.
async function resolveIrregularWriteWeek(
  organization: string,
  mode: ScopeMode,
  requestedWeekId: unknown,
): Promise<ProcessCheckWeekDto | null> {
  const current = await resolveProcessWeek(mode, IRREGULAR_TEST_WEEK_HUB);
  const requested =
    typeof requestedWeekId === "string" && requestedWeekId.trim() ? requestedWeekId.trim() : null;
  if (!requested || requested === current?.weekId) return current;
  const allowed = await hasActiveProcessCheckException(requested, organization, "irregular");
  if (!allowed) {
    throw new ProcessMasterError(422, "선택한 주차는 편집할 수 없습니다(예외 허용 주차가 아닙니다)");
  }
  const exWeek = await resolveProcessWeekByWeekId(requested);
  if (!exWeek?.weekId) {
    throw new ProcessMasterError(400, "예외 주차(weeks 행)를 찾을 수 없습니다");
  }
  return exWeek;
}

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
  week_id: string;
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
  // 댓글 수집 상태(2026-07-19) — 컬럼 미적용/미선택이면 undefined → null(collectionKind=unknown/not_collected).
  raw_comment_count?: number | null;
  comment_collection_status?: string | null;
  comment_collection_error_code?: string | null;
};

const ROW_SELECT =
  "id,week_id,kind,act_name,applicant_admin_name,target_user_id,target_user_name,duration_minutes,reason,point_a,point_b,point_c,crew_reaction,review_link,scheduled_check_at,status,completed_at,created_at,attempt_count,last_error";
// 댓글 수집 상태 컬럼 — 적용 시에만 SELECT 에 덧붙인다(getIrregularBoard 에서 collectionColumnsAvailable 게이트).
const COLLECTION_COLS = "raw_comment_count,comment_collection_status,comment_collection_error_code";

// 수집 상태 컬럼 적용 여부 — true 만 캐시(적용 후 영구). 미적용이면 SELECT 제외(조회는 unknown/not_collected).
let _irrCollectionColAvailable = false;
async function collectionColumnsAvailable(): Promise<boolean> {
  if (_irrCollectionColAvailable) return true;
  const { error } = await supabaseAdmin
    .from("process_irregular_acts")
    .select("comment_collection_status")
    .limit(1);
  if (!error) {
    _irrCollectionColAvailable = true;
    return true;
  }
  if (error.code === "42703" || error.code === "PGRST204" || error.code === "PGRST205") return false;
  return true; // 다른 에러면 있다고 보고 진행(실제 쿼리에서 표면화).
}

type RecipientRow = {
  user_id: string | null;
  nickname: string;
  match_type: string;
  match_reason: string | null;
};

function toRowDto(
  r: IrregularRow,
  recipientsByRef: Map<string, RecipientRow[]> = new Map(),
  nowMs: number = Date.now(),
): ProcessIrregularActRowDto {
  const kind: IrregularKind = r.kind === "manual_grant" ? "manual_grant" : "review_request";
  const rawStatus: IrregularStatus = r.status === "completed" ? "completed" : "pending";
  // 검수 시점 자동 완료 — review_request + pending 인데 검수 시점이 지났으면 표시/통계상 '체크 완료'.
  //   ⚠ DB status 는 그대로(여기서 write 없음). 포인트 적립·실제 검수는 워커가 담당.
  const status: IrregularStatus = effectiveIrregularStatus(kind, rawStatus, r.scheduled_check_at, nowMs);
  const autoCompleted = status === "completed" && rawStatus === "pending";
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
    rawStatus,
    autoCompleted,
    // 자동 완료(워커 미처리)면 실제 완료 시각이 없으므로 검수 시점을 완료 시각으로 표시.
    completedAt: r.completed_at ?? (autoCompleted ? r.scheduled_check_at : null),
    createdAt: r.created_at,
    recipients: recs,
    matchedCount: recs.filter((x) => x.matchType === "matched").length,
    attemptCount: r.attempt_count ?? 0,
    lastError: r.last_error,
    // 댓글 수집 상태 — 정규와 동일 SoT. ⚠ rawStatus(DB 원본) 기준으로 파생한다: 검수 시점 경과로 표시만
    //   완료된(autoCompleted·worker 미처리) 행은 아직 수집한 적이 없으므로 not_collected 로 보여야 한다.
    rawCommentCount: r.raw_comment_count ?? null,
    collectionKind: deriveCommentCollectionStatus({
      status: rawStatus,
      collectionStatus: isCommentCollectionStoredStatus(r.comment_collection_status)
        ? r.comment_collection_status
        : null,
      rawCommentCount: r.raw_comment_count ?? null,
      matchedCount: recs.filter((x) => x.matchType === "matched").length,
    }),
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
    // 체크 완료/대기 = 유효 상태(검수 시점 자동 완료 반영).
    completed: acts.filter((a) => a.status === "completed").length,
    pending: acts.filter((a) => a.status === "pending").length,
    all: acts.filter((a) => a.crewReaction === "all").length,
    partial: acts.filter((a) => a.crewReaction === "partial").length,
  };
}

// 주차 드롭다운 목록 = 프로세스 체크와 동일 공용 SoT(resolveSelectableProcessWeeks). 변동 액트는
//   "process-irregular" hub 키로 위임(현재 시즌 W1~현재주차·미래 미포함·테스트 W13 폴드 정책 유지).

// ── 보드 조회 (org × 선택주차 × 대상고객 스코프) ───────────────────────────────
//   selectedWeekId: 드롭다운 선택 주차(목록 내 weekId). 미지정/목록 밖이면 현재 주차로 폴백.
//   과거 주차 = 조회 전용(editable=false). 미래 주차는 목록에 없으므로 선택 불가.
export async function getIrregularBoard(
  organization: string,
  mode: ScopeMode = "operating",
  selectedWeekId?: string | null,
): Promise<ProcessIrregularBoardDto> {
  const nowMs = Date.now();
  // 활성 예외 주차(process_check_windows · org+"irregular" 스코프) — 기본 목록 밖 주차도 선택·편집 허용.
  const exceptionWeekIds = await getActiveProcessCheckExceptionWeekIds(organization, "irregular");
  const { options, currentWeekId, selectedWeekDtoByMs } =
    await resolveSelectableProcessWeeks(mode, IRREGULAR_TEST_WEEK_HUB, exceptionWeekIds);

  // 선택 주차 결정 — 목록(현재 시즌 W1~현재 + 예외 주차)에 있는 weekId 만 허용. 그 외는 현재 주차.
  const validIds = new Set(options.map((o) => o.weekId).filter((x): x is string => Boolean(x)));
  const effectiveWeekId =
    selectedWeekId && validIds.has(selectedWeekId) ? selectedWeekId : currentWeekId;

  // 선택 주차 DTO(라벨·날짜·status) — ms 매핑으로 역추적.
  let week: ProcessCheckWeekDto | null = null;
  for (const dto of selectedWeekDtoByMs.values()) {
    if (dto.weekId && dto.weekId === effectiveWeekId) {
      week = dto;
      break;
    }
  }
  // 폴백(weeks 행 없음 등) — 기존 현재 주차 resolver 로 라벨만이라도 채운다.
  if (!week) week = await resolveProcessWeek(mode, IRREGULAR_TEST_WEEK_HUB);

  // 편집 가능 = 현재 주차이거나 활성 예외 주차(추가 허용).
  const editable =
    Boolean(effectiveWeekId) &&
    (effectiveWeekId === currentWeekId || exceptionWeekIds.has(effectiveWeekId as string));

  if (!effectiveWeekId) {
    return {
      organization,
      week,
      weeks: options,
      selectedWeekId: null,
      editable: false,
      summary: summarize([]),
      acts: [],
    };
  }

  // 스코프 분기 = 행에 기록된 scope_mode(operating/test). review_request 는 대상자 미선택(null)
  //   이라 target 기준 필터 불가 → 생성 시 보드 모드를 그대로 박은 scope_mode 로 분리한다.
  //   ⚠ origin='emergency_rest'(긴급 휴식 Po.C 지급용 내부 액트)는 이 보드에서 숨긴다 — 크루
  //     Detail Log/주간 포인트(process_point_awards 원장)엔 정상 반영되며, 여기서만 제외한다.
  //     origin 컬럼 미적용(42703) 환경에선 필터 없이 조회(그 땐 긴급 액트 자체가 없다).
  const runQuery = (cols: string) =>
    supabaseAdmin
      .from("process_irregular_acts")
      .select(cols)
      .eq("organization_slug", organization)
      .eq("week_id", effectiveWeekId)
      .eq("scope_mode", mode)
      .order("created_at", { ascending: false });
  // 댓글 수집 상태 컬럼(적용 시에만 SELECT). origin 컬럼과 독립적으로 degrade.
  const collectionAvail = await collectionColumnsAvailable();
  const baseSel = collectionAvail ? `${ROW_SELECT},${COLLECTION_COLS}` : ROW_SELECT;
  let hasOrigin = true;
  let res = await runQuery(baseSel + ",origin");
  if (res.error && res.error.code === "42703") {
    hasOrigin = false;
    res = await runQuery(baseSel);
  }
  if (res.error) throw migrationHint(res.error) ?? new ProcessMasterError(500, res.error.message);

  const rawRows = (res.data ?? []) as unknown as Array<
    IrregularRow & { origin?: string | null }
  >;
  const rows: IrregularRow[] = hasOrigin
    ? rawRows.filter((r) => r.origin !== "emergency_rest")
    : rawRows;
  const recipients = await loadRecipientsByRef(rows.map((r) => r.id));
  const acts = rows.map((r) => toRowDto(r, recipients, nowMs));

  return {
    organization,
    week,
    weeks: options,
    selectedWeekId: effectiveWeekId,
    editable,
    summary: summarize(acts),
    acts,
  };
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

// ── 공통 필드 파싱(검수 링크·수동 입력 공용) ──────────────────────────────────
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

// ── 검수 링크(review_request) 생성 — 대상자 미선택·pending(worker 가 사후 식별/완료) ──────
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
  weekId?: unknown; // 선택 주차(weeks.id) — 현재와 다르면 활성 예외("irregular")일 때만 허용.
}): Promise<ProcessIrregularActRowDto> {
  const { organization, mode, adminId } = input;
  if (input.kind !== "review_request") {
    throw new ProcessMasterError(400, "이 경로는 링크 신청(review_request) 전용입니다");
  }
  const common = parseCommonFields(input);

  // 검수 링크(필수·http) + 검수 시점(필수·now<.<=now+7d).
  let reviewLink: string | null = null;
  if (typeof input.reviewLink === "string" && input.reviewLink.trim()) {
    const link = validateReviewLink(input.reviewLink);
    if (!link.ok) throw new ProcessMasterError(400, link.error);
    reviewLink = link.value;
  }
  if (!reviewLink) throw new ProcessMasterError(400, "링크 신청은 링크가 필수입니다");

  const week = await resolveIrregularWriteWeek(organization, mode, input.weekId);
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
  if (!scheduledCheckAt) throw new ProcessMasterError(400, "링크 신청은 검수 시점이 필수입니다");

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

// ── 수동 입력(manual_grant) 생성 — 대상 크루 명단(복수)·생성 즉시 completed(created==completed) ──
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
  weekId?: unknown; // 선택 주차(weeks.id) — 현재와 다르면 활성 예외("irregular")일 때만 허용.
}): Promise<ProcessIrregularActRowDto> {
  const { organization, mode, adminId } = input;
  // 수동 입력는 '전원' 선택 불가 — 항상 '부분'(포인트 방식 ab|c 택1)만 가능.
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
      throw new ProcessMasterError(422, "대상 크루가 해당 클럽(org) 소속이 아닙니다");
    }
  }

  const week = await resolveIrregularWriteWeek(organization, mode, input.weekId);
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
  //   best-effort: 적립 실패(마이그레이션 미적용 PGRST205 등)가 수동 입력 생성을 깨뜨리지 않게 격리.
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

// ── 액트 보완(admin 회원 주차 상세) — 단일 크루·단일 주차 변동 액트 즉시 부여 ──────────────
//   수동 부여(createManualGrant)와 동일한 원장·적립 SoT(accrueForCompletedIrregular)를 재사용하되:
//     · 주차 게이트가 다르다 — createManualGrant 는 resolveIrregularWriteWeek(현재주/예외주만)라 과거
//       확정 주차를 막는다. 액트 보완은 과거 확정 주차가 주 대상이므로 상위 라우트의 isCrewWeekEditable
//       (running/tallying 잠금)로 게이트하고, 여기선 지정 weekId 를 직접 사용한다(적립 era 만 방어).
//     · origin=ACT_SUPPLEMENT_ORIGIN 으로 출처를 남긴다(감사/추적·향후 필터 가능).
//     · 무-트랜잭션 보상: 이후 단계 실패 시 앞서 만든 행을 되돌린다(orphan act/award 방지).
//     · 결정적 snapshot 재생성(recomputeWeeklyCardsSnapshotsForUsers)으로 즉시 반영.
export const ACT_SUPPLEMENT_ORIGIN = "act_supplement" as const;

async function findAwardId(source: string, refId: string, userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("id")
    .eq("source", source)
    .eq("ref_id", refId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function createActSupplement(input: {
  organization: string;
  mode: ScopeMode;
  adminId: string;
  userId: string; // 대상 크루 user_profiles.user_id (단일)
  weekId: string; // weeks.id (실제 주차 — 상위 라우트가 카드 startDate 로 되짚은 값)
  actName: unknown;
  reason?: unknown;
  pointA?: unknown;
  pointB?: unknown;
  pointC?: unknown;
}): Promise<{ actId: string; awardId: string | null; deduped: boolean; growth: RejudgeResult | null }> {
  const { organization, mode, adminId, userId, weekId } = input;

  // 부분 액트 — 포인트 방식은 값에서 파생(C>0 → "c" else "ab"). 정규화·상호배타는 parseCommonFields(SoT).
  const pointMode = Number(input.pointC ?? 0) > 0 ? "c" : "ab";
  const common = parseCommonFields({
    ...input,
    durationMinutes: null,
    crewReaction: "partial",
    pointMode,
  });
  if (common.pointA <= 0 && common.pointB <= 0 && common.pointC <= 0) {
    throw new ProcessMasterError(400, "포인트를 1점 이상 부여해야 합니다");
  }

  // 대상 크루 스코프+소속 검증(fail-closed).
  const scope = await resolveUserScope(mode, organization as OrganizationSlug);
  assertUserIdsInScope(scope, [userId]);
  const { data: prof, error: pErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .eq("user_id", userId)
    .maybeSingle();
  if (pErr) throw new ProcessMasterError(500, pErr.message);
  const p = prof as { user_id: string; display_name: string | null; organization_slug: string | null } | null;
  if (!p) throw new ProcessMasterError(404, "대상 크루(user_profiles)를 찾을 수 없습니다");
  if (p.organization_slug !== organization) {
    throw new ProcessMasterError(422, "대상 크루가 해당 클럽(org) 소속이 아닙니다");
  }

  // 주차(weeks) — 지정 weekId 직접 사용(과거 확정 주차 대상). 적립 era 만 방어(이전 주차=적립 대상 아님).
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,season_key,week_number,iso_year,iso_week")
    .eq("id", weekId)
    .maybeSingle();
  const week = wk as {
    id: string; start_date: string; season_key: string | null; week_number: number | null;
    iso_year: number | null; iso_week: number | null;
  } | null;
  if (!week) throw new ProcessMasterError(404, "주차(weeks 행)를 찾을 수 없습니다");
  if (!isAccrualAllowedWeek(mode, week)) {
    throw new ProcessMasterError(422, "포인트 적립 대상 주차가 아닙니다(적립 시작 주차 이전)");
  }

  // 중복 제출 방지(콘텐츠+시간창 20초) — 더블클릭/재시도 멱등. 동일 admin·주차·액트명·포인트로 최근
  //   생성된 보완 액트가 같은 크루에게 있으면 신규 생성 대신 그 액트 반환.
  const dupWindowIso = new Date(Date.now() - 20_000).toISOString();
  const { data: recentActs } = await supabaseAdmin
    .from("process_irregular_acts")
    .select("id")
    .eq("origin", ACT_SUPPLEMENT_ORIGIN)
    .eq("week_id", weekId)
    .eq("applicant_admin_id", adminId)
    .eq("act_name", common.actName)
    .eq("point_a", common.pointA)
    .eq("point_b", common.pointB)
    .eq("point_c", common.pointC)
    .gte("created_at", dupWindowIso);
  const recentIds = ((recentActs ?? []) as { id: string }[]).map((r) => r.id);
  if (recentIds.length) {
    const { data: rec } = await supabaseAdmin
      .from("process_check_review_recipients")
      .select("ref_id")
      .eq("source", "irregular")
      .eq("user_id", userId)
      .in("ref_id", recentIds)
      .limit(1);
    const dupRef = ((rec ?? []) as { ref_id: string }[])[0]?.ref_id;
    if (dupRef) {
      // 멱등 재시도 — 신규 생성/재집계 없음(성장 결과 변동 없음).
      return { actId: dupRef, awardId: await findAwardId("irregular", dupRef, userId), deduped: true, growth: null };
    }
  }

  const nowIso = new Date().toISOString();
  const applicantAdminName = await resolveAdminName(adminId);
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("process_irregular_acts")
    .insert({
      organization_slug: organization,
      week_id: weekId,
      kind: "manual_grant",
      act_name: common.actName,
      applicant_admin_id: adminId,
      applicant_admin_name: applicantAdminName,
      target_user_id: null,
      target_user_name: null,
      scope_mode: mode,
      duration_minutes: null,
      reason: common.reason,
      point_a: common.pointA,
      point_b: common.pointB,
      point_c: common.pointC,
      crew_reaction: "partial",
      review_link: null,
      scheduled_check_at: nowIso, // 신청 == 검수 완료 시점(개념)
      status: "completed",
      completed_at: nowIso,
      origin: ACT_SUPPLEMENT_ORIGIN,
    })
    .select("id")
    .single();
  if (insErr) throw migrationHint(insErr) ?? new ProcessMasterError(500, insErr.message);
  const actId = (inserted as { id: string }).id;

  // recipients(matched) — 단일 대상.
  const { error: recErr } = await supabaseAdmin.from("process_check_review_recipients").insert({
    source: "irregular",
    ref_id: actId,
    organization_slug: organization,
    scope_mode: mode,
    user_id: userId,
    nickname: p.display_name?.trim() || "(이름 없음)",
    match_type: "matched",
    match_reason: "supplement",
  });
  if (recErr) {
    await supabaseAdmin.from("process_irregular_acts").delete().eq("id", actId); // 보상
    throw migrationHint(recErr) ?? new ProcessMasterError(500, recErr.message);
  }

  // 즉시 적립. 스킵/실패 시 보상(act·recipients 삭제)로 orphan 방지.
  try {
    const acc = await accrueForCompletedIrregular(actId);
    if ("skipped" in acc && acc.skipped) {
      await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "irregular").eq("ref_id", actId);
      await supabaseAdmin.from("process_irregular_acts").delete().eq("id", actId);
      throw new ProcessMasterError(422, `포인트 적립이 스킵되었습니다(${acc.reason})`);
    }
  } catch (e) {
    if (e instanceof ProcessMasterError) throw e;
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "irregular").eq("ref_id", actId);
    await supabaseAdmin.from("process_irregular_acts").delete().eq("id", actId);
    throw new ProcessMasterError(500, e instanceof Error ? e.message : "포인트 적립에 실패했습니다");
  }

  // 파생 재계산: 성장 결과(uws) 재판정 → 카드 snapshot 재생성 → 성장 통계 → 품계(주차 참여자).
  //   uwp 는 accrueForCompletedIrregular 안에서 이미 재집계됨(rejudge earned 최신 보장).
  const growth = await recomputeDerivedAfterActMutation({
    userId,
    weekId,
    organizationSlug: organization as OrganizationSlug,
  });

  return { actId, awardId: await findAwardId("irregular", actId, userId), deduped: false, growth };
}

// 과거 주차 행은 조회 전용 — 현재 주차가 아니면 변경/취소 차단(fail-closed).
//   현재 주차(weeks.id) = resolveProcessWeek(운영=현재 / 테스트=W13 폴드)와 동일 SoT.
//   단, 활성 예외 주차(process_check_windows · org+"irregular")면 조회 전용 해제(추가 허용).
async function assertCurrentWeekRow(
  row: IrregularRow,
  mode: ScopeMode,
  organization: string,
): Promise<void> {
  const week = await resolveProcessWeek(mode, IRREGULAR_TEST_WEEK_HUB);
  if (week?.weekId && row.week_id === week.weekId) return;
  if (await hasActiveProcessCheckException(row.week_id, organization, "irregular")) return;
  throw new ProcessMasterError(409, "과거 주차 변동 액트는 조회 전용입니다(변경/취소 불가)");
}

// ── 체크 완료 처리 (review_request: pending → completed) ───────────────────────
export async function completeIrregularAct(
  id: string,
  organization: string,
  mode: ScopeMode,
): Promise<ProcessIrregularActRowDto> {
  const row = await loadScopedRow(id, organization, mode);
  await assertCurrentWeekRow(row, mode, organization);
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
  await assertCurrentWeekRow(row, mode, organization); // 과거 주차 = 조회 전용
  // 수동 입력는 '전원'으로 변경 불가(부분만 가능).
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
  const row = await loadScopedRow(id, organization, mode); // 존재 + org + 대상 스코프 검증
  await assertCurrentWeekRow(row, mode, organization); // 과거 주차 = 조회 전용
  // 검수 링크(review_request) 체크 취소는 '체크 대기'(검수 시점 전)에서만. 검수 시점이 지나면
  //   조회 시점 자동 완료 상태이므로 취소 불가(체크 완료 후 취소 불가 정책).
  if (row.kind === "review_request" && row.status === "pending" && row.scheduled_check_at) {
    const t = Date.parse(row.scheduled_check_at);
    if (!Number.isNaN(t) && Date.now() >= t) {
      throw new ProcessMasterError(409, "검수 시점이 지나 체크 취소할 수 없습니다");
    }
  }
  // 적립 회수 — 원장 행 제거 후 영향 사용자 user_weekly_points 재계산 + snapshot 무효화(best-effort).
  try {
    await revokeForAct("irregular", id);
  } catch (e) {
    console.warn("[accrual] 삭제 시 적립 회수 실패(격리)", { actId: id, message: e instanceof Error ? e.message : String(e) });
  }
  const { error } = await supabaseAdmin.from("process_irregular_acts").delete().eq("id", id);
  if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
}

// ── ↩ 실행 취소(직전 "실행 전" 상태 복원) — 운영/테스트 공용(QA 전용 아님) ──────────
//
//   Action Control 표준 UX. 종류별로 "실행하기 전" 상태로 되돌린다(단순 표시 복원이 아니라
//   해당 액트를 다시 검수/부여할 수 있는 상태로 복원):
//     · 링크 신청(review_request) : 체크 완료 → 체크 대기(검수 전). 행은 유지하고 재검수 가능하게
//         scheduled_check_at 을 비운다(과거 예약시각이 남으면 조회 시점 자동 완료로 다시 완료 표시되어
//         '즉시 검수'가 숨겨짐 → 재테스트 불가). completed_at=null.
//     · 수동 부여(manual_grant) : 부여 전(부재) → 행 삭제.
//   공통: 적립 포인트 회수(revokeForAct) + recipients 삭제 + 대상 유저 snapshot **명시적 재계산**
//         (invalidate 의 컨텍스트 의존 우회 → direct==HTTP 결정성). org/mode 무관 동일 로직.
//
//   차단: 링크 신청이 예약 검수 시각 경과로 '표시상 자동 완료'(DB 는 아직 pending·워커 미실행)된 건은
//         되돌릴 실행(적립/완료)이 없어 409 로 거부(호출부에서 ↩ 도 비활성).
export type IrregularRollbackResult = {
  ok: true;
  id: string;
  kind: IrregularKind;
  status: "pending" | "deleted";
  revokedUserIds: string[];
  recipientsDeleted: number;
  recompute?: { requested: number; recomputed: number; failed: number };
};

export async function rollbackIrregularAct(
  id: string,
  organization: string,
  mode: ScopeMode,
): Promise<IrregularRollbackResult> {
  const row = await loadScopedRow(id, organization, mode); // 존재 + org + scope_mode 검증
  await assertCurrentWeekRow(row, mode, organization); // 과거 주차 = 조회 전용(409)
  const kind: IrregularKind = row.kind === "manual_grant" ? "manual_grant" : "review_request";

  // 링크 신청이 DB pending 인데 예약 검수 시각이 지나 '표시상 자동 완료'된 건 — 되돌릴 실행이 없음.
  if (kind === "review_request" && row.status !== "completed" && row.scheduled_check_at) {
    const t = Date.parse(row.scheduled_check_at);
    if (!Number.isNaN(t) && Date.now() >= t) {
      throw new ProcessMasterError(
        409,
        "예약 검수 시각이 지나 자동 완료된 건은 되돌릴 수 없습니다",
      );
    }
  }

  // 1) 적립 회수(원장 삭제 + user_weekly_points 재합산 + 등급 + snapshot 무효화) — 멱등.
  const { revokedUserIds } = await revokeForAct("irregular", id);

  // 2) recipients 삭제(source=irregular). 재검수 시 워커/즉시검수가 다시 기록.
  const { data: delRec, error: recErr } = await supabaseAdmin
    .from("process_check_review_recipients")
    .delete()
    .eq("source", "irregular")
    .eq("ref_id", id)
    .select("id");
  if (recErr) throw migrationHint(recErr) ?? new ProcessMasterError(500, recErr.message);
  const recipientsDeleted = (delRec ?? []).length;

  // 3) 종류별 '실행 전' 복원.
  let status: "pending" | "deleted";
  if (kind === "manual_grant") {
    const { error } = await supabaseAdmin.from("process_irregular_acts").delete().eq("id", id);
    if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
    status = "deleted";
  } else {
    // 링크 신청 → 체크 대기 복원. scheduled_check_at 을 비워 재검수(즉시 검수) 가능 상태로.
    //   ⚠ 정규 rollback 과 동일 정책 — 이전 검수 시도의 수집 진단값(last_error·수집 상태·원본 댓글 수·오류)도
    //     초기화한다(recipients 는 위에서 이미 삭제). 취소된 결과가 재검수 최신 결과처럼 노출되지 않게.
    const collectionAvail = await collectionColumnsAvailable();
    const { error } = await supabaseAdmin
      .from("process_irregular_acts")
      .update({
        status: "pending",
        completed_at: null,
        scheduled_check_at: null,
        ...uncompleteResetStamp(collectionAvail),
      })
      .eq("id", id);
    if (error) throw migrationHint(error) ?? new ProcessMasterError(500, error.message);
    status = "pending";
  }

  // 4) 대상 유저 snapshot 명시적 재계산(direct==HTTP 결정성). 회수 대상이 없으면 스킵.
  let recompute: { requested: number; recomputed: number; failed: number } | undefined;
  if (revokedUserIds.length > 0) {
    const rc = await recomputeWeeklyCardsSnapshotsForUsers(revokedUserIds, { concurrency: 4 });
    recompute = { requested: rc.requested, recomputed: rc.recomputed, failed: rc.failed };
  }

  return { ok: true, id, kind, status, revokedUserIds, recipientsDeleted, recompute };
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
