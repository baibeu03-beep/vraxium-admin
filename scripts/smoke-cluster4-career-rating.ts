/**
 * 실무 경력(career) 평점 → 강화상태 P0 smoke (순수 로직, DB 불필요).
 *
 *   npx tsx scripts/smoke-cluster4-career-rating.ts
 *
 * 검증:
 *   1. grade S/A/B/C → points 10/8/6/4, careerRatingStatus=success
 *   2. grade D → points 2, careerRatingStatus=fail
 *   3. grade 없음(null) → careerRatingStatus=unevaluated
 *   4. 강화상태(computeCluster4Enhancement, career):
 *        - 마감 전                              → pending (등급/제출 무관)
 *        - 마감 후 + S/A/B/C(success)           → success
 *        - 마감 후 + D(fail)                    → fail
 *        - 마감 후 + 미평가 + 제출함            → pending (평가 대기)
 *        - 마감 후 + 미평가 + 미제출 (P1)       → fail (career_not_submitted)
 *   5. 비career(careerGradeVerdict 미전달): 마감 후 → success (회귀 없음)
 */
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import {
  CAREER_GRADES,
  CAREER_GRADE_POINTS,
  careerRatingStatusFromGrade,
  gradeToPoints,
  isCareerGradeFail,
  type CareerGrade,
} from "@/lib/careerGrade";

function assert(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `  ${ok ? "✅" : "❌"} ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
  );
  if (!ok) process.exitCode = 1;
}

// career 호출부(toLineDetail)와 동일하게 grade → verdict 를 만든 뒤 강화상태를 계산.
function careerEnhancement(
  grade: CareerGrade | null,
  deadlinePassed: boolean,
  hasSubmission = false,
) {
  return computeCluster4Enhancement({
    hasTarget: true,
    deadlinePassed,
    hasSubmission,
    isCareer: true,
    careerGradeVerdict: careerRatingStatusFromGrade(grade),
  }).enhancementStatus;
}

function main() {
  console.log("════════ 1·2·3. grade → points / ratingStatus ════════");
  assert("S → 10", gradeToPoints("S"), 10);
  assert("A → 8", gradeToPoints("A"), 8);
  assert("B → 6", gradeToPoints("B"), 6);
  assert("C → 4", gradeToPoints("C"), 4);
  assert("D → 2", gradeToPoints("D"), 2);
  assert("CAREER_GRADES 순서", CAREER_GRADES, ["S", "A", "B", "C", "D"]);

  for (const g of ["S", "A", "B", "C"] as CareerGrade[]) {
    assert(`${g} ratingStatus=success`, careerRatingStatusFromGrade(g), "success");
    assert(`${g} isCareerGradeFail=false`, isCareerGradeFail(g), false);
  }
  assert("D ratingStatus=fail", careerRatingStatusFromGrade("D"), "fail");
  assert("D isCareerGradeFail=true", isCareerGradeFail("D"), true);
  assert("null ratingStatus=unevaluated", careerRatingStatusFromGrade(null), "unevaluated");

  console.log("\n════════ 4. career 강화상태 (target=선발+배정) ════════");
  // 마감 전 — 등급/제출 무관 pending
  assert("마감 전 + grade S", careerEnhancement("S", false), "pending");
  assert("마감 전 + grade D", careerEnhancement("D", false), "pending");
  assert("마감 전 + 미평가", careerEnhancement(null, false), "pending");
  // 마감 후
  assert("마감 후 + S", careerEnhancement("S", true), "success");
  assert("마감 후 + A", careerEnhancement("A", true), "success");
  assert("마감 후 + B", careerEnhancement("B", true), "success");
  assert("마감 후 + C", careerEnhancement("C", true), "success");
  assert("마감 후 + D", careerEnhancement("D", true), "fail");
  // P1: 미평가 — 제출 여부로 분기
  assert("마감 후 + 미평가 + 미제출", careerEnhancement(null, true, false), "fail");
  assert("마감 후 + 미평가 + 제출함", careerEnhancement(null, true, true), "pending");

  // reason 까지 점검 (career 전용 reason 이 정확한지)
  assert(
    "마감 후 + D reason",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: true, careerGradeVerdict: "fail" }).enhancementReason,
    "career_grade_fail",
  );
  assert(
    "마감 후 + 미평가 + 미제출 reason",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: true, careerGradeVerdict: "unevaluated" }).enhancementReason,
    "career_not_submitted",
  );
  assert(
    "마감 후 + 미평가 + 제출함 reason",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: true, careerGradeVerdict: "unevaluated" }).enhancementReason,
    "career_unevaluated_after_deadline",
  );

  console.log("\n════════ 5. 비career 회귀 (careerGradeVerdict 미전달) ════════");
  assert(
    "비career 마감 후 = success",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false }).enhancementStatus,
    "success",
  );
  assert(
    "비career 마감 전 = pending",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: false, hasSubmission: false, isCareer: false }).enhancementStatus,
    "pending",
  );
  // career 인데 verdict 미전달(방어) — 기존 동작(success) 유지
  assert(
    "career verdict 미전달 마감 후 = success",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: true }).enhancementStatus,
    "success",
  );

  console.log("\n════════ grade↔points 일관성 (DB CHECK 와 동일) ════════");
  assert("CAREER_GRADE_POINTS", CAREER_GRADE_POINTS, { S: 10, A: 8, B: 6, C: 4, D: 2 });

  console.log(
    process.exitCode ? "\n❌ smoke 실패" : "\n════════ smoke 완료 (전부 통과) ════════",
  );
}

main();
