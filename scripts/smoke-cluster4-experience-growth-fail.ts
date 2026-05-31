/**
 * 실무 경험 필수 슬롯(도출/분석/평가) 기준 주차 성장 실패 판정 smoke (2026-05-30).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-experience-growth-fail.ts
 *
 * A. reduceExperienceRequiredSlotVerdict 순수 환원 (DB 불필요):
 *    1) 도출/분석/평가 모두 success            → pass
 *    2) 셋 중 하나라도 fail                     → fail
 *    3) fail 없고 pending 포함                  → pending
 *    4) 셋 다 not_applicable                    → not_applicable (실패 아님)
 *    5) success + not_applicable (fail/pending 없음) → pass
 * B. shouldApplyExperienceFail — 주차 상태 반영 가드:
 *    - 현재주(running)/휴식(personal/official_rest) 에는 fail 강제 안 함
 *    - verdict 가 fail 이 아니면 반영 안 함
 * C. (DB 있으면) fetchExperienceRequiredSlotStatusByWeek 라이브 1주차 표본 출력.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  reduceExperienceRequiredSlotVerdict,
  shouldApplyExperienceFail,
  shouldSyncWeekStatusToFail,
  fetchExperienceRequiredSlotStatusByWeek,
  type ExperienceRequiredSlotStatus,
} from "@/lib/lineAvailability";
import {
  syncExperienceGrowthWeekStatuses,
} from "@/lib/cluster4WeeklyGrowthData";

function assert(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(
    `  ${ok ? "✅" : "❌"} ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`,
  );
  if (!ok) process.exitCode = 1;
}

const slots = (
  s1: ExperienceRequiredSlotStatus["enhancementStatus"],
  s2: ExperienceRequiredSlotStatus["enhancementStatus"],
  s3: ExperienceRequiredSlotStatus["enhancementStatus"],
): ExperienceRequiredSlotStatus[] => [
  { slotOrder: 1, category: "derivation", enhancementStatus: s1 },
  { slotOrder: 2, category: "analysis", enhancementStatus: s2 },
  { slotOrder: 3, category: "evaluation", enhancementStatus: s3 },
];

async function main() {
  console.log("════════ A. verdict 환원 (순수) ════════");
  assert(
    "검증1 모두 success → pass",
    reduceExperienceRequiredSlotVerdict(slots("success", "success", "success")).status,
    "pass",
  );
  assert(
    "검증2 하나 fail → fail",
    reduceExperienceRequiredSlotVerdict(slots("success", "fail", "pending")).status,
    "fail",
  );
  assert(
    "검증2 failedSlotOrders",
    reduceExperienceRequiredSlotVerdict(slots("success", "fail", "success")).failedSlotOrders,
    [2],
  );
  assert(
    "검증3 pending 포함 → pending",
    reduceExperienceRequiredSlotVerdict(slots("success", "pending", "success")).status,
    "pending",
  );
  assert(
    "검증4 모두 not_applicable → not_applicable",
    reduceExperienceRequiredSlotVerdict(
      slots("not_applicable", "not_applicable", "not_applicable"),
    ).status,
    "not_applicable",
  );
  assert(
    "검증5 success + not_applicable → pass",
    reduceExperienceRequiredSlotVerdict(slots("success", "not_applicable", "not_applicable")).status,
    "pass",
  );
  // fail 은 not_applicable 보다 우선
  assert(
    "fail + not_applicable → fail",
    reduceExperienceRequiredSlotVerdict(slots("fail", "not_applicable", "not_applicable")).status,
    "fail",
  );

  console.log("\n════════ B. shouldApplyExperienceFail 가드 ════════");
  assert("검증2 fail + success주 → 반영", shouldApplyExperienceFail("fail", "success"), true);
  assert("fail + 이미 fail주 → 반영", shouldApplyExperienceFail("fail", "fail"), true);
  assert("검증5 현재주(running) → 미반영", shouldApplyExperienceFail("fail", "running"), false);
  assert("tallying → 미반영", shouldApplyExperienceFail("fail", "tallying"), false);
  assert("검증6 personal_rest → 미반영", shouldApplyExperienceFail("fail", "personal_rest"), false);
  assert("검증6 official_rest → 미반영", shouldApplyExperienceFail("fail", "official_rest"), false);
  assert("pass verdict → 미반영", shouldApplyExperienceFail("pass", "success"), false);
  assert("pending verdict → 미반영", shouldApplyExperienceFail("pending", "success"), false);
  assert("not_applicable verdict → 미반영", shouldApplyExperienceFail("not_applicable", "success"), false);

  console.log("\n════════ D. shouldSyncWeekStatusToFail 가드 (DB write 조건) ════════");
  // 검증1: success + verdict fail + 비현재주 → fail 로 변경
  assert("검증1 success+fail+비현재주 → 변경", shouldSyncWeekStatusToFail("success", "fail", false), true);
  // 검증2: fail + verdict fail → 후보 자체가 아님 (currentStatus!=='success')
  assert("검증2 fail 행은 후보 아님 → no-op", shouldSyncWeekStatusToFail("fail", "fail", false), false);
  // 검증3·4: rest 행은 후보 아님
  assert("검증3 personal_rest → no-op", shouldSyncWeekStatusToFail("personal_rest", "fail", false), false);
  assert("검증4 official_rest → no-op", shouldSyncWeekStatusToFail("official_rest", "fail", false), false);
  // 검증5: 현재주 → no-op
  assert("검증5 현재주(success+fail) → no-op", shouldSyncWeekStatusToFail("success", "fail", true), false);
  // 검증6: not_applicable / pending / pass → no-op
  assert("검증6 not_applicable → no-op", shouldSyncWeekStatusToFail("success", "not_applicable", false), false);
  assert("pending verdict → no-op", shouldSyncWeekStatusToFail("success", "pending", false), false);
  assert("pass verdict → no-op", shouldSyncWeekStatusToFail("success", "pass", false), false);

  console.log("\n════════ C. 라이브 표본 (DB) ════════");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  ⚠️ Supabase env 없음 — 라이브 케이스 생략 (순수 검증은 통과)");
    console.log("\n════════ smoke 완료 ════════");
    return;
  }

  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(url, key);
  const { data: t } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,week_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(1);
  const sample = (t ?? [])[0] as { target_user_id: string; week_id: string } | undefined;
  if (!sample) {
    console.log("  ⚠️ user target 없음 — 라이브 케이스 생략");
    console.log("\n════════ smoke 완료 ════════");
    return;
  }

  const { data: userTargets } = await sb
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", sample.target_user_id);
  const weekIds = [
    ...new Set(((userTargets ?? []) as { week_id: string }[]).map((r) => r.week_id)),
  ];

  const verdictMap = await fetchExperienceRequiredSlotStatusByWeek(
    sample.target_user_id,
    weekIds,
  );
  console.log(`  사용자 ${sample.target_user_id}, 주차 ${weekIds.length}개`);
  let shown = 0;
  for (const [weekId, v] of verdictMap) {
    if (shown >= 5) break;
    console.log(
      `  ${weekId.slice(0, 8)} | verdict=${v.status} | slots=${v.requiredSlots
        .map((s) => `${s.slotOrder}:${s.enhancementStatus}`)
        .join(",")} | failed=${JSON.stringify(v.failedSlotOrders)}`,
    );
    shown++;
  }
  // verdict 값은 항상 4종 중 하나
  const allValid = [...verdictMap.values()].every((v) =>
    ["pass", "fail", "pending", "not_applicable"].includes(v.status),
  );
  assert("모든 주차 verdict 유효", allValid, true);

  console.log("\n════════ E. sync 멱등성 (라이브) ════════");
  // 안전장치: 표본 사용자에 fail verdict 가 없을 때만 실제 sync 실행(=0 flip, DB 무변경) →
  // 함수 경로/멱등성을 비파괴적으로 확인한다. fail 이 있으면 데이터 변경을 피하기 위해 건너뛴다.
  const hasFailVerdict = [...verdictMap.values()].some((v) => v.status === "fail");
  if (hasFailVerdict) {
    console.log("  ⚠️ 표본 사용자에 fail verdict 존재 — 비파괴 원칙상 라이브 write 생략");
  } else {
    const run1 = await syncExperienceGrowthWeekStatuses(sample.target_user_id);
    const run2 = await syncExperienceGrowthWeekStatuses(sample.target_user_id);
    console.log(
      `  run1=${JSON.stringify({ scanned: run1.scannedSuccessWeeks, flipped: run1.flippedToFail })} run2=${JSON.stringify({ scanned: run2.scannedSuccessWeeks, flipped: run2.flippedToFail })}`,
    );
    assert("검증7 fail verdict 없음 → flip 0 (무변경)", run1.flippedToFail, 0);
    assert("검증7 재실행 멱등 → flip 0", run2.flippedToFail, 0);
  }

  console.log("\n════════ smoke 완료 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
