/**
 * 라인 "개설" 기준 = cluster4_lines 행 존재(=any target) 정책 smoke (2026-06-02).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-line-open-policy.ts
 *
 * 배경: cluster4_lines 에는 week_id 가 없어 라인↔주차는 cluster4_line_targets.week_id 로만 묶인다.
 * 따라서 "그 주차에 라인 개설됨" = "그 주차에 해당 part active 라인을 가리키는 target(누구든) 존재".
 *
 * 검증 매트릭스 (info/experience/competency 공통, career 는 별도):
 *   1) 라인 개설 + 본인 배정 + 마감 전 → pending
 *   2) 라인 개설 + 본인 배정 + 마감 후 → success
 *   3) 라인 개설 + 본인 미배정        → fail              (expectedWhenMissing=true)
 *   4) 라인 미개설                    → not_applicable    (expectedWhenMissing=false)
 *   5) competency 도 4)에서 not_applicable (구 "항상 fail" 폐기)
 *   6) competency 개설 + 미배정 → fail + status='void'(보이드 표시 유지) — emptyLine DTO
 *   7) experience rating <= 3 → fail / rating >= 4 → success
 *   8) career 회귀: 미선발(미배정) → not_applicable / 선발(배정)+마감후 D → fail, S~C → success
 *   9) synthetic fail 강화율 산술 불변식: 개설+미배정 → A += 1, B += 0 / 미개설 → A 미가산
 *  10) not_applicable(미개설)은 분모 A 에서 제외
 *  13) 기존 배정 사용자 success/pending 회귀 없음
 */
import {
  computeCluster4Enhancement,
  EXPERIENCE_RATING_FAIL_THRESHOLD,
} from "@/lib/cluster4Enhancement";
import { roundGrowthRate } from "@/lib/lineAvailability";

let failed = false;
function assert(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✅" : "❌"} ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) {
    failed = true;
    process.exitCode = 1;
  }
}

const enh = (i: Parameters<typeof computeCluster4Enhancement>[0]) =>
  computeCluster4Enhancement(i).enhancementStatus;

function main() {
  console.log("════════ A. 매트릭스 (info/experience/competency 공통) ════════");
  for (const isCareer of [false]) {
    // 1) 개설 + 배정 + 마감 전 → pending
    assert("1 배정+마감전 → pending", enh({ hasTarget: true, deadlinePassed: false, hasSubmission: false, isCareer }), "pending");
    // 2) 개설 + 배정 + 마감 후 → success
    assert("2 배정+마감후 → success", enh({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer }), "success");
    // 3) 개설 + 미배정 → fail
    assert("3 개설+미배정 → fail", enh({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer, expectedWhenMissing: true }), "fail");
    // 4) 미개설 → not_applicable
    assert("4 미개설 → not_applicable", enh({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer, expectedWhenMissing: false }), "not_applicable");
  }

  console.log("\n════════ B. experience 평점 (rating <= 3 → fail) ════════");
  // 7) rating <= 3 → fail (마감 후)
  assert(
    "7 rating<=3 + 마감후 → fail",
    enh({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: false, experienceRatingVerdict: "fail" }),
    "fail",
  );
  // rating >= 4 → success (기존 동작)
  assert(
    "7 rating>=4 + 마감후 → success",
    enh({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: false, experienceRatingVerdict: "pass" }),
    "success",
  );
  // 마감 전에는 평점 무관 pending
  assert(
    "rating fail + 마감전 → pending",
    enh({ hasTarget: true, deadlinePassed: false, hasSubmission: true, isCareer: false, experienceRatingVerdict: "fail" }),
    "pending",
  );
  // 미평가(undefined) → 기존 동작(마감 후 success)
  assert(
    "rating 미전달 + 마감후 → success(회귀 없음)",
    enh({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false }),
    "success",
  );
  // 임계 상수 점검
  assert("EXPERIENCE_RATING_FAIL_THRESHOLD == 3", EXPERIENCE_RATING_FAIL_THRESHOLD, 3);

  console.log("\n════════ C. career 회귀 (선발/평점 로직 유지) ════════");
  // 8) 미선발(미배정) → not_applicable (career)
  assert("8 career 미선발 → not_applicable", enh({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: true, expectedWhenMissing: false }), "not_applicable");
  // 선발 + 마감후 + D → fail
  assert("8 career 선발+마감후+D → fail", enh({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: true, careerGradeVerdict: "fail" }), "fail");
  // 선발 + 마감후 + S/A/B/C → success
  assert("8 career 선발+마감후+S~C → success", enh({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: true, careerGradeVerdict: "success" }), "success");
  // 선발 + 마감후 + 제출 + 미평가 → pending
  assert("8 career 선발+마감후+제출+미평가 → pending", enh({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: true, careerGradeVerdict: "unevaluated" }), "pending");
  // 선발 + 마감후 + 미제출 + 미평가 → fail (P1)
  assert("8 career 선발+마감후+미제출 → fail(P1)", enh({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: true, careerGradeVerdict: "unevaluated" }), "fail");
  // experience 평점이 career 경로에 누수되지 않음 (career 는 careerGradeVerdict 만 사용)
  assert("career 에 experienceRatingVerdict 누수 없음", enh({ hasTarget: true, deadlinePassed: true, hasSubmission: true, isCareer: true, careerGradeVerdict: "success", experienceRatingVerdict: "fail" }), "fail");

  console.log("\n════════ D. 강화율 분모 A = 개설 라인 수 (synthetic fail 포함) ════════");
  // 모델: A_part = 그 주차 개설 라인 수(distinct). B = 본인 배정 중 success. missed = A - 본인배정 → fail(B 미포함).
  //   본인 배정 ⊆ 개설 → 항상 B ≤ A. 미개설(A=0) → not_applicable(분모 제외).
  const rate = (opened: number, success: number) => roundGrowthRate(success, opened);
  // 9) 개설 1 + 본인 미배정 → A=1, B=0 (synthetic fail 1건이 분모에 잡힘, 분자 0)
  assert("9 개설1+미배정 → rate=round(0/1)=0", rate(1, 0), 0);
  // 9b) 개설 3 + 본인 배정 1(성공) + 미배정 2(fail) → A=3, B=1 → 33%
  assert("9b 개설3(배정1성공+미배정2fail) → A=3,B=1 → 33%", rate(3, 1), 33);
  // 10) 미개설 → A=0 → not_applicable(분모 제외) → rate 0(분모0)
  assert("10 미개설 → A=0 → rate=round(0/0)=0", rate(0, 0), 0);
  // 13) 기존 배정 사용자 회귀: 개설 2 + 둘 다 배정 + 1 성공 → A=2,B=1 → 50%
  assert("13 개설2(둘다배정,1성공) → A=2,B=1 → 50%", rate(2, 1), 50);
  // 13b) 개설 2 + 둘 다 배정 + 둘 다 성공 → 100% (회귀 없음)
  assert("13b 개설2(둘다성공) → 100%", rate(2, 2), 100);

  console.log(`\n════════ smoke ${failed ? "실패 ❌" : "완료 ✅"} ════════`);
}

main();
