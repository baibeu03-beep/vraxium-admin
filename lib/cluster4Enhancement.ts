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
// career 평점 반영 (P0 → P1 갱신 — 2026-06-01):
//   career 라인은 선발(=타깃)·제출·평점(grade)을 함께 본다. 타깃 있음(선발됨) + 마감 후 기준:
//     - grade D(2점, 3점 이하)            → fail    (career_grade_fail)
//     - grade S/A/B/C(4점 이상)           → success (career_grade_success)
//     - grade 미입력 + 제출함              → pending (career_unevaluated_after_deadline; 평가 대기)
//     - grade 미입력 + 미제출 (P1)         → fail    (career_not_submitted; 선발됐는데 미진행)
//   careerGradeVerdict 는 career 호출부(weekly-cards)만 전달한다. 미전달(undefined)이면
//   기존 동작(마감 후 = success) 그대로이므로 info/experience/competency 는 영향받지 않는다.
//   마감 전(deadlinePassed=false)에는 grade·제출과 무관하게 항상 pending.
//
// experience 평점 반영 (2026-06-02):
//   experience 라인은 마감 후 평점(cluster4_experience_line_evaluations.rating)을 본다.
//     - rating <= 3 (EXPERIENCE_RATING_FAIL_THRESHOLD) → fail (experience_rating_fail)
//     - rating 미입력 / rating >= 4                    → 기존 동작(마감 후 success)
//   experienceRatingVerdict 는 experience 호출부(weekly-cards)만 전달한다. career 와
//   상호배타(한 라인은 career 또는 experience 중 하나)이며, 미전달(undefined)이면 영향 없음.
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
  // career 평점 평가 결과 (P0). career 호출부만 전달한다. 미전달이면 기존 동작 유지.
  //   "success" → 마감 후 success, "fail" → 마감 후 fail, "unevaluated" → 마감 후 pending.
  careerGradeVerdict?: "success" | "fail" | "unevaluated" | null;
  // experience 평점 평가 결과. experience 호출부만 전달한다. 미전달이면 기존 동작 유지.
  //   "fail" → 마감 후 fail (rating <= 3), "pass"/null → 기존 동작(마감 후 success).
  experienceRatingVerdict?: "fail" | "pass" | null;
};

// experience 평점 강화 실패 임계: rating <= 3. weekly-cards / smoke 공용 SoT.
export const EXPERIENCE_RATING_FAIL_THRESHOLD = 3;

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
    // experience 평점 반영. experienceRatingVerdict 미전달(undefined)인 비experience 경로는
    // 이 분기를 건너뛴다. career 와 상호배타이므로 순서 무관.
    if (input.experienceRatingVerdict === "fail") {
      return {
        enhancementStatus: "fail",
        submissionStatus,
        enhancementReason: "experience_rating_fail",
      };
    }
    // career 평점 반영 (P0). careerGradeVerdict 미전달(undefined)인 비career 경로는
    // 아래 분기를 모두 건너뛰고 기존대로 success 를 반환한다.
    const careerGradeVerdict = input.careerGradeVerdict ?? null;
    if (careerGradeVerdict === "fail") {
      return {
        enhancementStatus: "fail",
        submissionStatus,
        enhancementReason: "career_grade_fail",
      };
    }
    if (careerGradeVerdict === "unevaluated") {
      // 미평가: 제출했으면 평가 대기(pending), 미제출이면 강화 실패(P1).
      if (hasSubmission) {
        return {
          enhancementStatus: "pending",
          submissionStatus,
          enhancementReason: "career_unevaluated_after_deadline",
        };
      }
      return {
        enhancementStatus: "fail",
        submissionStatus,
        enhancementReason: "career_not_submitted",
      };
    }
    if (careerGradeVerdict === "success") {
      return {
        enhancementStatus: "success",
        submissionStatus,
        enhancementReason: "career_grade_success",
      };
    }
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
