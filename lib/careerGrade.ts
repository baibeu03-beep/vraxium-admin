// 실무 경력(career) 평점 등급 ↔ 점수 변환의 단일 출처(SoT).
//
// 정책 (P0 — 2026-06-01 확정):
//   - 등급: S / A / B / C / D
//   - 점수 환산: S=10, A=8, B=6, C=4, D=2
//   - "3점 이하"는 강화 실패 기준 → 현재 등급 체계에서는 D(2점)만 해당.
//   - grade 미입력은 "미평가(unevaluated)"로 보고 fail 로 단정하지 않는다
//     (미진행과 운영자 미평가를 데이터로 구분할 수 없으므로 fail 은 명시적 D 입력으로만 확정).
//
// 이 파일은 브라우저-세이프(서버 전용 import 금지). DB CHECK 와 별개로 코드측 변환을
// 한 곳에 모아, weekly-cards / detail DTO / enhancement / admin API 가 모두 동일하게 쓴다.

export type CareerGrade = "S" | "A" | "B" | "C" | "D";

// 평가 상태 — careerRatingStatus DTO 필드의 값.
//   unevaluated: grade 미입력 (미진행 또는 운영자 미평가)
//   success    : grade 입력 + 강화 성공 (S/A/B/C, 4점 이상)
//   fail       : grade 입력 + 강화 실패 (D, 2점 = 3점 이하)
export type CareerRatingStatus = "unevaluated" | "success" | "fail";

export const CAREER_GRADES: readonly CareerGrade[] = ["S", "A", "B", "C", "D"];

export const CAREER_GRADE_POINTS: Record<CareerGrade, number> = {
  S: 10,
  A: 8,
  B: 6,
  C: 4,
  D: 2,
};

// 강화 실패 임계: points <= 3. 현재 등급 체계에선 D(2점)만 해당.
// 향후 등급 추가(예: E=1) 시 이 상수만으로 일괄 반영된다.
export const CAREER_FAIL_POINT_THRESHOLD = 3;

export function isCareerGrade(value: unknown): value is CareerGrade {
  return typeof value === "string" && (CAREER_GRADES as readonly string[]).includes(value);
}

export function gradeToPoints(grade: CareerGrade): number {
  return CAREER_GRADE_POINTS[grade];
}

// grade 가 강화 실패(3점 이하)인가. D → true, S/A/B/C → false.
export function isCareerGradeFail(grade: CareerGrade): boolean {
  return CAREER_GRADE_POINTS[grade] <= CAREER_FAIL_POINT_THRESHOLD;
}

// grade(또는 미입력 null) → careerRatingStatus. 마감 여부와 무관한 "평가 결과" 축이다.
//   (마감 전/후의 pending 처리는 enhancementStatus 쪽에서 별도로 결정한다.)
export function careerRatingStatusFromGrade(
  grade: CareerGrade | null,
): CareerRatingStatus {
  if (grade === null) return "unevaluated";
  return isCareerGradeFail(grade) ? "fail" : "success";
}
