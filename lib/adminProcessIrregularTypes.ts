// Browser-safe constants/types/parsers for 변동 액트 (/admin/processes/check/irregular).
// Must not import server-only modules here.
//
// 정책 (2026-06-15 — 변동 액트 Phase):
//   - 정규 기준표(process_acts) 외 검수 링크/수동 입력 인스턴스. 신규 테이블 process_irregular_acts.
//   - 신청자 = 운영진(admin_users) · 대상자 = 고객앱 사용자(user_profiles).
//   - org + test/operating 모드 분리는 target_user_id 기준.
//   - ⚠ user_weekly_points.points · 주차 성장 계산 · snapshot · checkGate · demoUserId 무접촉.
//     point A/B/C 는 표시/관리용 정의값(고객앱 점수 미연동).

import type { ProcessCheckWeekDto, CommentCollectionStatusKind } from "@/lib/adminProcessCheckTypes";

// 주차 DTO 는 프로세스 체크와 동일 SoT(공용) 재사용.
export type { ProcessCheckWeekDto } from "@/lib/adminProcessCheckTypes";
export {
  formatCheckDateTimeKo,
  validateReviewLink,
  validateScheduledCheckAt,
} from "@/lib/adminProcessCheckTypes";

// ── 화면 도움말 key ─────────────────────────────────────────────────────────────
//   /admin/processes/check/irregular 는 별도 화면(ProcessIrregularManager)이라 검수 링크/수동 부여·
//   전원/부분·통계 7칸 등 이 페이지 고유 요소가 많다 → 프로세스 체크(admin.processCheck.*)와 섞지 않고
//   irregular 전용 네임스페이스로 관리한다. org/mode 로는 분기하지 않는다(순수 표시 전용).
//   ⚠ 이 페이지에 없는 요소(상태창/로그창/진행요약/액트관리 섹션)는 key 를 만들지 않는다.
export const PROCESS_IRREGULAR_HELP_KEYS = {
  pageTitle: "admin.processes.check.irregular.page.title",
  buttonReviewAll: "admin.processes.check.irregular.button.reviewAll",
  buttonPartial: "admin.processes.check.irregular.button.partial",
  filterWeek: "admin.processes.check.irregular.filter.week",
  statTotal: "admin.processes.check.irregular.stat.total",
  statReviewRequest: "admin.processes.check.irregular.stat.reviewRequest",
  statManualGrant: "admin.processes.check.irregular.stat.manualGrant",
  statCompleted: "admin.processes.check.irregular.stat.completed",
  statPending: "admin.processes.check.irregular.stat.pending",
  statAll: "admin.processes.check.irregular.stat.all",
  statPartial: "admin.processes.check.irregular.stat.partial",
  columnKind: "admin.processes.check.irregular.column.kind",
  columnActType: "admin.processes.check.irregular.column.actType",
  columnActName: "admin.processes.check.irregular.column.actName",
  columnApplicant: "admin.processes.check.irregular.column.applicant",
  columnDuration: "admin.processes.check.irregular.column.duration",
  columnReason: "admin.processes.check.irregular.column.reason",
  columnPoA: "admin.processes.check.irregular.column.poA",
  columnPoB: "admin.processes.check.irregular.column.poB",
  columnPoC: "admin.processes.check.irregular.column.poC",
  columnApplyTimeActual: "admin.processes.check.irregular.column.applyTimeActual",
  columnReviewTimeActual: "admin.processes.check.irregular.column.reviewTimeActual",
  // 이행 시점(실제) = 신청 시점(실제)+검수 시점(실제) 통합 열의 도움말 키.
  columnExecutionTimeActual: "admin.processes.check.irregular.column.executionTimeActual",
  columnStatus: "admin.processes.check.irregular.column.status",
  columnManualAction: "admin.processes.check.irregular.column.manualAction",
} as const;

// ── 종류 (검수 링크 / 수동 입력) ───────────────────────────────────────────────
export type IrregularKind = "review_request" | "manual_grant";
export const IRREGULAR_KINDS = ["review_request", "manual_grant"] as const;
export const IRREGULAR_KIND_LABEL: Record<IrregularKind, string> = {
  review_request: "링크 신청",
  manual_grant: "수동 부여",
};
export function isIrregularKind(v: unknown): v is IrregularKind {
  return v === "review_request" || v === "manual_grant";
}

// 카페(발생/미발생) — DB 컬럼이 아니라 kind 파생값(입력/저장 안 함, 사용자 수정 불가).
//   review_request(검수 링크) → "발생" · manual_grant(수동 입력) → "미발생".
export function irregularCafeLabel(kind: IrregularKind): string {
  return kind === "manual_grant" ? "미발생" : "발생";
}

// ── 체크 상태 (대기 / 완료) ────────────────────────────────────────────────────
export type IrregularStatus = "pending" | "completed";
export const IRREGULAR_STATUS_LABEL: Record<IrregularStatus, string> = {
  pending: "체크 대기",
  completed: "체크 완료",
};
// 검수 시점 자동 완료(조회 시점 파생) — review_request + pending 인데 검수 시점이 지났으면 '체크 완료'.
//   ⚠ DB status 는 그대로 두고(영구 write 없음) 표시/통계만 완료로 본다. 포인트 적립·실제 검수는
//      기존 워커 로직이 담당(미접촉). nowMs 는 호출부(서버 GET)가 주입.
export function effectiveIrregularStatus(
  kind: IrregularKind,
  status: IrregularStatus,
  scheduledCheckAt: string | null,
  nowMs: number,
): IrregularStatus {
  if (status !== "pending" || kind !== "review_request") return status;
  if (!scheduledCheckAt) return status;
  const t = Date.parse(scheduledCheckAt);
  return !Number.isNaN(t) && nowMs >= t ? "completed" : status;
}
export function irregularStatusClass(s: IrregularStatus): string {
  return s === "completed"
    ? "border-green-300 bg-green-100 text-green-800"
    : "border-amber-300 bg-amber-100 text-amber-800";
}

// ── 액트 종류 (전원 / 부분) ───────────────────────────────────────────────────
//   전원(all)     = 해당 액트를 전체 대상에게 적용.
//   부분(partial) = 일부 대상에게만 적용.
//   (2026-06-18 — 구 enum required|optional|selection|none → 2종(전원/부분)으로 전환.
//    레거시 값은 coerceIrregularCrewReaction 으로 신규 값에 매핑해 화면에 다시 노출되지 않도록 한다.)
export type IrregularCrewReaction = "all" | "partial";
export const IRREGULAR_CREW_REACTIONS = ["all", "partial"] as const;
export const IRREGULAR_CREW_REACTION_DEFAULT: IrregularCrewReaction = "all";
export const IRREGULAR_CREW_REACTION_LABEL: Record<IrregularCrewReaction, string> = {
  all: "전원",
  partial: "부분",
};
export function isIrregularCrewReaction(v: unknown): v is IrregularCrewReaction {
  return v === "all" || v === "partial";
}
// 레거시(required|optional|selection|none) → 신규(all|partial) 매핑.
//   '필수(required)'=전원 / 그 외=부분. 마이그레이션 미적용 DB·과거 행도 신규 값으로만 표시(구 값 비노출).
export function coerceIrregularCrewReaction(v: unknown): IrregularCrewReaction {
  if (v === "all" || v === "partial") return v;
  if (v === "required") return "all";
  return "partial";
}

// ── 포인트 방식 (부분 액트 전용 — A+B 부여 / C 부여 택1) ────────────────────────
//   (2026-06-18 정책) 전원(all)  = A/B/C 모두 사용(해당자 A+B / 미해당자 C).
//                     부분(partial)= 포인트 방식 택1 — ab(A+B만) 또는 c(C만).
//   포인트 방식은 "입력 시점" 개념(사용자가 명시 선택) — DB 별도 컬럼 없이 A/B/C 값으로 결과를 담는다.
//   (ab → C=0 / c → A=B=0). 서버 normalizeIrregularPoints 가 단일 SoT 로 강제(프론트 우회 차단).
export type IrregularPointMode = "ab" | "c";
export const IRREGULAR_POINT_MODES = ["ab", "c"] as const;
export const IRREGULAR_POINT_MODE_DEFAULT: IrregularPointMode = "ab";
export const IRREGULAR_POINT_MODE_LABEL: Record<IrregularPointMode, string> = {
  ab: "A+B 부여",
  c: "C 부여",
};
export function isIrregularPointMode(v: unknown): v is IrregularPointMode {
  return v === "ab" || v === "c";
}

// ── 포인트 / 소요시간 검증 (서버·클라 공용 SoT) ────────────────────────────────
export function isIrregularPoint(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20;
}

// 포인트 정규화(서버/클라 공용 SoT) — 액트 종류 + 포인트 방식 기준으로 A/B/C 를 강제한다.
//   전원(all)    : A/B/C 모두 0~20 허용(포인트 방식 무관).
//   부분(partial): pointMode 필수.
//        ab → { A, B, C:0 }   (포인트 C 저장 불가)
//        c  → { A:0, B:0, C } (포인트 A/B 저장 불가)
//   ⚠ 부분인데 pointMode 가 없거나 잘못된 경우 → ok:false (저장 거부). 프론트 우회/API 직접호출도 차단.
export function normalizeIrregularPoints(
  crewReaction: IrregularCrewReaction,
  pointMode: IrregularPointMode | null | undefined,
  a: number,
  b: number,
  c: number,
):
  | { ok: true; pointA: number; pointB: number; pointC: number }
  | { ok: false; error: string } {
  if (!isIrregularPoint(a) || !isIrregularPoint(b) || !isIrregularPoint(c)) {
    return { ok: false, error: "포인트 A/B/C 는 0~20 정수여야 합니다" };
  }
  if (crewReaction === "all") {
    return { ok: true, pointA: a, pointB: b, pointC: c };
  }
  // 부분(partial) — 포인트 방식 필수.
  if (!isIrregularPointMode(pointMode)) {
    return { ok: false, error: "부분 액트는 포인트 방식(A+B 부여 / C 부여)을 선택해야 합니다" };
  }
  return pointMode === "ab"
    ? { ok: true, pointA: a, pointB: b, pointC: 0 }
    : { ok: true, pointA: 0, pointB: 0, pointC: c };
}
// 소요 시간(분) — nullable. 입력 시 1~600 정수.
export function isIrregularDuration(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 600;
}

// ── DTO ────────────────────────────────────────────────────────────────────────
// 자동 검수(worker)로 식별된 크루 1명.
export type ProcessIrregularRecipientDto = {
  userId: string | null; // matched=우리 크루 user_id / review=null 가능
  nickname: string;
  matchType: "matched" | "review";
  matchReason: string | null;
};

export type ProcessIrregularActRowDto = {
  id: string;
  kind: IrregularKind;
  kindLabel: string;
  cafeLabel: string; // 카페 — kind 파생("종류" 바로 다음 컬럼). 발생/미발생.
  actName: string;
  applicantAdminName: string; // 신청자(운영진)
  // 대상 고객 — manual_grant=단일 대상 / review_request=null(크롤링으로 사후 식별).
  targetUserId: string | null;
  targetUserName: string | null;
  durationMinutes: number | null; // 소요 시간(분)
  reason: string | null; // 액트 신청 사유
  pointA: number;
  pointB: number;
  pointC: number;
  crewReaction: IrregularCrewReaction;
  crewReactionLabel: string;
  reviewLink: string | null;
  scheduledCheckAt: string | null; // 검수 시점
  // status = 표시/통계용 유효 상태(검수 시점 자동 완료 반영). rawStatus = DB 원본(취소 가능 판정용).
  status: IrregularStatus;
  rawStatus: IrregularStatus;
  autoCompleted: boolean; // 검수 시점 경과로 자동 완료 표시된 행(DB 는 아직 pending).
  completedAt: string | null;
  createdAt: string; // 신청 시점(실제)
  // 자동 검수 결과(review_request·completed 후). 매칭된 크루 + 수동확인 목록.
  recipients: ProcessIrregularRecipientDto[];
  matchedCount: number; // recipients 중 matched 수
  // worker 진행/실패 표시.
  attemptCount: number;
  lastError: string | null;
  // 댓글 수집 상태(2026-07-19) — 정규와 동일 SoT(deriveCommentCollectionStatus). "정상 0 vs 오류 0"·
  //   "매칭 실패" 구분 + [댓글 다시 수집] 노출 판정. 레거시/미기록이면 rawCommentCount=null → unknown.
  rawCommentCount: number | null;
  collectionKind: CommentCollectionStatusKind;
};

export type ProcessIrregularSummary = {
  total: number; // 전체 갯수
  reviewRequest: number; // 링크 신청(kind=review_request)
  manualGrant: number; // 수동 부여(kind=manual_grant)
  completed: number; // 체크 완료(유효 상태)
  pending: number; // 체크 대기(유효 상태)
  all: number; // 전원(crew_reaction=all)
  partial: number; // 부분(crew_reaction=partial)
};

// 주차 드롭다운 1개 옵션(현재 시즌 W1~현재주차). 미래 주차는 목록에 포함하지 않는다.
export type ProcessIrregularWeekOptionDto = {
  weekId: string | null;
  weekNumber: number;
  weekName: string; // "3주차"
  periodLabel: string; // 드롭다운 표기 — "26년 봄 시즌 3주차"(연도+시즌+주차, processCheckLogPeriodLabel SoT)
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  isOfficialRest: boolean;
  statusLabel: string; // "공식 활동 주차" | "공식 휴식 주차"
  isCurrent: boolean; // 현재(편집 가능) 주차 여부
};

export function irregularWeekStatusLabel(isOfficialRest: boolean): string {
  return isOfficialRest ? "공식 휴식 주차" : "공식 활동 주차";
}

export type ProcessIrregularBoardDto = {
  organization: string;
  week: ProcessCheckWeekDto | null; // 선택 주차
  weeks: ProcessIrregularWeekOptionDto[]; // 드롭다운(현재 시즌 W1~현재주차)
  selectedWeekId: string | null;
  editable: boolean; // 선택 주차 == 현재 주차 일 때만 true(과거 주차 = 조회 전용)
  summary: ProcessIrregularSummary;
  acts: ProcessIrregularActRowDto[]; // 최신순(생성 역순)
};

export function emptyProcessIrregularBoard(organization: string): ProcessIrregularBoardDto {
  return {
    organization,
    week: null,
    weeks: [],
    selectedWeekId: null,
    editable: false,
    summary: { total: 0, reviewRequest: 0, manualGrant: 0, completed: 0, pending: 0, all: 0, partial: 0 },
    acts: [],
  };
}

// 대상 고객 검색 결과(스코프 적용된 user_profiles 행).
export type IrregularTargetUserDto = {
  userId: string;
  displayName: string;
  authEmail: string | null;
  contactEmail: string | null;
};

// ── 생성 입력 파서(클라 1차 검증 · 서버 동일 재검증) ──────────────────────────
export type IrregularCreateInput = {
  kind: IrregularKind;
  actName: string;
  targetUserId: string | null; // manual_grant 만 필수 — review_request 는 null
  durationMinutes: number | null;
  reason: string | null;
  pointA: number;
  pointB: number;
  pointC: number;
  crewReaction: IrregularCrewReaction;
  reviewLink: string | null;
  scheduledCheckAt: string | null;
};

export const IRREGULAR_ACT_NAME_MAX = 60;
