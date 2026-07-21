// [오픈 확인] 재실행 허용 조건 판정 — 순수 함수(서버 강제 + 클라 버튼/문구 공유 SoT).
//
//   재실행 가능 = (1) 아직 검수 완료(published) 아님 AND (2) N주 목요일 00:01 KST 이전. 둘 다여야 허용.
//   최초 오픈 확인(open_confirmed=false)은 이 게이트 대상이 아니다 — 호출부가 "재실행일 때만" 평가한다.
//   reason 문자열은 서버(409)와 UI(툴팁/버튼)에서 동일하게 사용한다(단일 문구 SoT).

import { weekThursdayBoundaryMs } from "@/lib/seasonCalendar";
import type { WeekOrgResultStatus } from "@/lib/weekOrgResultState";

export type ReopenEligibility = { reopenable: boolean; reason: string | null };

export const REOPEN_BLOCKED_PUBLISHED = "검수가 완료된 주차는 오픈 확인을 다시 진행할 수 없습니다.";
export const REOPEN_BLOCKED_PAST_THURSDAY =
  "목요일 00:01(KST)이 지나 오픈 확인을 다시 진행할 수 없습니다.";
export const REOPEN_BLOCKED_NO_WEEKSTART =
  "주차 시작일을 확인할 수 없어 오픈 확인을 다시 진행할 수 없습니다.";

export function resolveReopenEligibility(input: {
  weekStartIso: string | null;
  reviewStatus: WeekOrgResultStatus;
  nowMs?: number;
}): ReopenEligibility {
  // 검수 완료(published) = 재실행 불가. (전역 result_reviewed_at 이 아니라 조직별 상태 SoT.)
  if (input.reviewStatus === "published") {
    return { reopenable: false, reason: REOPEN_BLOCKED_PUBLISHED };
  }
  const boundary = weekThursdayBoundaryMs(input.weekStartIso);
  if (Number.isNaN(boundary)) {
    return { reopenable: false, reason: REOPEN_BLOCKED_NO_WEEKSTART }; // fail-closed
  }
  const nowMs = input.nowMs ?? Date.now();
  if (nowMs >= boundary) {
    return { reopenable: false, reason: REOPEN_BLOCKED_PAST_THURSDAY };
  }
  return { reopenable: true, reason: null };
}
