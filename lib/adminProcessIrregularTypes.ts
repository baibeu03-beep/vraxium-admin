// Browser-safe constants/types/parsers for 비정규 액트 (/admin/processes/check/irregular).
// Must not import server-only modules here.
//
// 정책 (2026-06-15 — 비정규 액트 Phase):
//   - 정규 기준표(process_acts) 외 검수신청/수동부여 인스턴스. 신규 테이블 process_irregular_acts.
//   - 신청자 = 운영진(admin_users) · 대상자 = 고객앱 사용자(user_profiles).
//   - org + test/operating 모드 분리는 target_user_id 기준.
//   - ⚠ user_weekly_points.points · 주차 성장 계산 · snapshot · checkGate · demoUserId 무접촉.
//     point A/B/C 는 표시/관리용 정의값(고객앱 점수 미연동).

import type { ProcessCheckWeekDto } from "@/lib/adminProcessCheckTypes";

// 주차 DTO 는 프로세스 체크와 동일 SoT(공용) 재사용.
export type { ProcessCheckWeekDto } from "@/lib/adminProcessCheckTypes";
export {
  formatCheckDateTimeKo,
  validateReviewLink,
  validateScheduledCheckAt,
} from "@/lib/adminProcessCheckTypes";

// ── 종류 (검수 신청 / 수동 부여) ───────────────────────────────────────────────
export type IrregularKind = "review_request" | "manual_grant";
export const IRREGULAR_KINDS = ["review_request", "manual_grant"] as const;
export const IRREGULAR_KIND_LABEL: Record<IrregularKind, string> = {
  review_request: "검수 신청",
  manual_grant: "수동 부여",
};
export function isIrregularKind(v: unknown): v is IrregularKind {
  return v === "review_request" || v === "manual_grant";
}

// 카페(발생/미발생) — DB 컬럼이 아니라 kind 파생값(입력/저장 안 함, 사용자 수정 불가).
//   review_request(검수 신청) → "발생" · manual_grant(수동 부여) → "미발생".
export function irregularCafeLabel(kind: IrregularKind): string {
  return kind === "manual_grant" ? "미발생" : "발생";
}

// ── 체크 상태 (대기 / 완료) ────────────────────────────────────────────────────
export type IrregularStatus = "pending" | "completed";
export const IRREGULAR_STATUS_LABEL: Record<IrregularStatus, string> = {
  pending: "체크 대기",
  completed: "체크 완료",
};
export function irregularStatusClass(s: IrregularStatus): string {
  return s === "completed"
    ? "border-green-300 bg-green-100 text-green-800"
    : "border-amber-300 bg-amber-100 text-amber-800";
}

// ── 크루 반응 (필수 / 선택 / 선발 / 없음) ──────────────────────────────────────
export type IrregularCrewReaction = "required" | "optional" | "selection" | "none";
export const IRREGULAR_CREW_REACTIONS = ["required", "optional", "selection", "none"] as const;
export const IRREGULAR_CREW_REACTION_LABEL: Record<IrregularCrewReaction, string> = {
  required: "필수",
  optional: "선택",
  selection: "선발",
  none: "없음",
};
export function isIrregularCrewReaction(v: unknown): v is IrregularCrewReaction {
  return v === "required" || v === "optional" || v === "selection" || v === "none";
}

// ── 포인트 / 소요시간 검증 (서버·클라 공용 SoT) ────────────────────────────────
export function isIrregularPoint(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20;
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
  status: IrregularStatus;
  completedAt: string | null;
  createdAt: string;
  // 자동 검수 결과(review_request·completed 후). 매칭된 크루 + 수동확인 목록.
  recipients: ProcessIrregularRecipientDto[];
  matchedCount: number; // recipients 중 matched 수
  // worker 진행/실패 표시.
  attemptCount: number;
  lastError: string | null;
};

export type ProcessIrregularSummary = {
  total: number; // 전체 갯수
  reviewRequest: number; // 검수 신청(kind)
  manualGrant: number; // 수동 부여(kind)
  completed: number; // 체크 완료(status)
  pending: number; // 체크 대기(status)
};

export type ProcessIrregularBoardDto = {
  organization: string;
  week: ProcessCheckWeekDto | null;
  summary: ProcessIrregularSummary;
  acts: ProcessIrregularActRowDto[]; // 최신순(생성 역순)
};

export function emptyProcessIrregularBoard(organization: string): ProcessIrregularBoardDto {
  return {
    organization,
    week: null,
    summary: { total: 0, reviewRequest: 0, manualGrant: 0, completed: 0, pending: 0 },
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
