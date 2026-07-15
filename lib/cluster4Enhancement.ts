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
// 허브별 칸 정책 (2026-06-04 확정 — 본 함수는 불변, 호출부에서 입력으로 표현):
//   - info: 라인별 오픈/마감 여부. 미개설=not_applicable, 개설+미배정=fail(expectedWhenMissing),
//     배정+마감 전=pending(강화 대기), 배정+마감 후=success. 제출 여부는 판정 기준이 아니다.
//   - experience: 필수 슬롯(1·2·3·5)은 라인 행이 없어도 항상 오픈/마감 간주 → 해당 없음 불가
//     (칸 없으면 expectedWhenMissing=true placeholder → fail). 확장 슬롯(4)만 미개설=not_applicable.
//     rating<=3 은 마감 후 fail (experienceRatingVerdict).
//   - competency: 배정 칸은 pending→(수 22:00 마감)→success. 미배정+개설=fail 이되 표시축은
//     보이드(status="void") — enhancementStatus=fail 은 유지(분모 포함).
//   - career: 항상 6칸(부족분 보이드 패딩, not_applicable·분모 제외). 선발=pending/success/fail
//     (grade 반영), 미지원/미선발=not_applicable(개설 content 노출).
//   - 강화율: A = enhancementStatus ∈ {pending,success,fail} 칸 수, B = success 칸 수
//     (weekly-cards breakdownFromLines — 칸 상태와 강제 정합).
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
  //   "fail" → 마감 후 fail (rating 1~3), "unevaluated" → 마감 후 pending (rating 미입력=placeholder 0),
  //   "pass"/null → 기존 동작(마감 후 success).
  experienceRatingVerdict?: "fail" | "pass" | "unevaluated" | null;
};

// experience 평점 강화 실패 임계: rating <= 3. weekly-cards / smoke 공용 SoT.
export const EXPERIENCE_RATING_FAIL_THRESHOLD = 3;

// 주차 인정 point.check 기본 기준값 (2026-06-05 레거시 통합 라인 정책 정정).
//   주차 성공 = 평점 4점 이상(강화 성공) AND 그 주차 check(user_weekly_points.points) >= 기준값.
//   weeks.check_threshold 가 NULL 인 주차에 이 기본값을 적용한다. 관리자 UI/판정 공용 SoT.
//   강화 성공 판정(평점)에는 사용하지 않는다 — 주차 성공 게이트 전용.
export const DEFAULT_WEEK_CHECK_THRESHOLD = 30;

// check 게이트 강제(enforce) 기준 (2026-06-05 개정 — 명시적 provenance 플래그):
//   user_weekly_points.checks_migrated = true 인 행만 게이트를 강제한다.
//   (종전의 "사용자별 check 최대값 >= 10" 휴리스틱은 부분 시즌 이관·저분포 사용자에서
//    오판하므로 폐기 — 크기 추론이 아니라 행 단위 이관 여부로 판정한다.)
//   - 테스터: 시드 스크립트가 행 기록 시 true 설정 → enforce.
//   - 실사용자: 이관 전 잔존 행(default false) → 보존. 이관 파이프라인이 행을
//     checks_migrated=true 로 기록하면 별도 코드 수정 없이 그 (사용자, 주차)만 자동 enforce.
//     ⚠ 이관 계약: 이관 주차에 check 0건이어도 행(points=0, true)을 기록할 것 —
//       행 부재/false = 미이관(fail-safe 보존).
//   비레거시(2026 여름 W1 이후) 주차는 이 게이트를 사용하지 않는다.

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

  // Experience ratings are fixed during line opening. The rating is the SoT
  // for submission and reinforcement in every read mode/path.
  if (input.experienceRatingVerdict === "fail") {
    return {
      enhancementStatus: "fail",
      submissionStatus,
      enhancementReason: "experience_rating_fail",
    };
  }
  if (input.experienceRatingVerdict === "pass") {
    return {
      enhancementStatus: "success",
      submissionStatus,
      enhancementReason: "target_exists_after_deadline",
    };
  }
  if (input.experienceRatingVerdict === "unevaluated") {
    return {
      enhancementStatus: "pending",
      submissionStatus,
      enhancementReason: "experience_unevaluated_after_deadline",
    };
  }

  if (deadlinePassed) {
    // experience 평점 반영. experienceRatingVerdict 미전달(undefined)인 비experience 경로는
    // 이 분기를 건너뛴다. career 와 상호배타이므로 순서 무관.
    // 미평가(rating 미입력 = placeholder 0) → 아직 평가 전이므로 '강화 대기'.
    //   대상자로 선정됐으나 (소급 개설 등으로) 평점이 아직 입력되지 않은 경우, 마감이 지났다는
    //   이유만으로 즉시 강화 실패/성공으로 확정하지 않는다. 실제 평점 입력(별도 마감/확정 처리) 후에만
    //   rating 1~3 → fail, 4점 이상 → success 로 전환된다.
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
