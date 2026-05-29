// Cluster4 강화 상태(enhancementStatus) 단일 계산 함수.
//
// 정책 (lineTargetId = 1차 라인 제출 대상자 신호, 마감 = submission_closes_at = 수 22:00 KST):
//   - 타깃 있음 + 마감 지남                 → success            (submission 유무 무관)
//   - 타깃 있음 + 마감 전                    → pending            (submission 유무 무관)
//   - 타깃 없음 + 제출했어야 하는 대상       → fail               (명시적 기대 신호가 있을 때만)
//   - 타깃 없음 + 제출 불필요 + career       → not_applicable
//   - 타깃 없음 + 제출 불필요 + 비career     → not_applicable
//
// 중요: enhancementStatus 는 2차(라인 칸) submission 존재 여부로 success/fail 을
// 판단하지 않는다. 마감(수 22:00 KST) 후 타깃이 있으면 미기입이라도 success 다.
// submission(기입) 존재 여부는 submissionStatus 로 분리해 반환한다.
// fail 은 "원래 개설되어야 하는데 target/line 이 없음" 같은 예외에만 쓴다.
//
// 서버(weekly-cards / 어드민 라인 API)에서만 호출하고, 결과를 DTO 에 그대로 append 한다.
// DB 저장 컬럼이 아니라 런타임 파생값이다.

import type {
  Cluster4EnhancementReason,
  Cluster4EnhancementStatus,
  Cluster4SubmissionStatus,
} from "@/shared/cluster4.contracts";

export type Cluster4EnhancementInput = {
  // cluster4_line_targets row 존재 여부 (= 1차 라인 제출 대상자였는가).
  hasTarget: boolean;
  // 라인 제출 마감(submission_closes_at = 수 22:00 KST)이 현재 시각보다 과거인가. 타깃 없으면 무시.
  deadlinePassed: boolean;
  // 2차(라인 칸) submission row 존재 여부. submissionStatus 산정에만 쓰인다
  // (enhancementStatus 의 success/fail 판정에는 쓰지 않는다).
  hasSubmission: boolean;
  // 실무 경력(career) 라인 여부 — not_applicable 사유(reason) 구분용.
  isCareer: boolean;
  // 타깃이 없을 때 "원래 제출했어야 하는 대상"인가.
  // 현재 weekly-cards 는 타깃 부재 = 미배정 = 제출 불필요로 보므로 항상 false 를 전달한다.
  // (향후 명시적 기대-대상 신호가 생기면 true 를 넘겨 fail 분기를 활성화한다.)
  expectedWhenMissing?: boolean;
};

export type Cluster4EnhancementResult = {
  enhancementStatus: Cluster4EnhancementStatus;
  submissionStatus: Cluster4SubmissionStatus;
  enhancementReason: Cluster4EnhancementReason;
};

export function computeCluster4Enhancement(
  input: Cluster4EnhancementInput,
): Cluster4EnhancementResult {
  const { hasTarget, deadlinePassed, hasSubmission, isCareer } = input;
  const expectedWhenMissing = input.expectedWhenMissing ?? false;

  // 타깃 없음 — 1차 라인 대상자가 아니었다.
  if (!hasTarget) {
    if (expectedWhenMissing) {
      // 제출했어야 하는 대상인데 타깃이 없음 → 강화 실패.
      return {
        enhancementStatus: "fail",
        submissionStatus: "not_submitted",
        enhancementReason: "target_missing_required",
      };
    }
    // 애초에 제출할 필요가 없었음 → 해당 없음.
    return {
      enhancementStatus: "not_applicable",
      submissionStatus: "not_required",
      enhancementReason: isCareer
        ? "target_missing_not_required_career"
        : "target_missing_not_required_non_career",
    };
  }

  // 타깃 있음 — submission 유무는 submissionStatus 로만 반영하고
  // enhancementStatus 는 마감 여부로만 결정한다 (미기입이라도 마감 후면 success).
  const submissionStatus: Cluster4SubmissionStatus = hasSubmission
    ? "submitted"
    : "not_submitted";

  if (deadlinePassed) {
    return {
      enhancementStatus: "success",
      submissionStatus,
      enhancementReason: "target_exists_after_deadline",
    };
  }

  return {
    enhancementStatus: "pending",
    submissionStatus,
    enhancementReason: "target_exists_before_deadline",
  };
}
