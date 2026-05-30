/**
 * 강화율/강화상태 통일 기준 smoke (2026-05-30 확정 기준).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-enhancement.ts
 *
 * A. 4케이스 강화상태 (wiring 이 computeCluster4Enhancement 에 넘기는 입력 그대로):
 *    1) 배정 있음 + 마감 전  = pending
 *    2) 배정 있음 + 마감 후  = success
 *    3) 배정 없음 + info 라인 개설됨(expectedWhenMissing=true) = fail
 *    4) info 라인 미개설(expectedWhenMissing=false)            = not_applicable
 * B. roundGrowthRate = Math.round 확인 (+ ceil 과 차이 케이스)
 * C. 실 DB: A(배정 수)·B(success 수)가 같은 기준(line_targets+마감)인지, B<=A, rate 예시
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import {
  roundGrowthRate,
  fetchInfoLineCountsByWeek,
  fetchInfoLineSuccessCountsByWeek,
  fetchWeeksWithAnyInfoLine,
} from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function assert(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✅" : "❌"} ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log("════════ A. 4케이스 강화상태 ════════");
  // 1) 배정 있음 + 마감 전 = pending  (toLineDetail: hasTarget=true, deadlinePassed=false)
  assert(
    "case1 배정O+마감전",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: false, hasSubmission: false, isCareer: false }).enhancementStatus,
    "pending",
  );
  // 2) 배정 있음 + 마감 후 = success (제출 무관 → hasSubmission=false 로도 success)
  assert(
    "case2 배정O+마감후",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false }).enhancementStatus,
    "success",
  );
  // 3) 배정 없음 + info 라인 개설됨 = fail (emptyLine: expectedWhenMissing=true)
  assert(
    "case3 배정X+개설O",
    computeCluster4Enhancement({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: false, expectedWhenMissing: true }).enhancementStatus,
    "fail",
  );
  // 4) info 라인 미개설 = not_applicable (emptyLine: expectedWhenMissing=false)
  assert(
    "case4 미개설",
    computeCluster4Enhancement({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: false, expectedWhenMissing: false }).enhancementStatus,
    "not_applicable",
  );

  console.log("\n════════ B. roundGrowthRate = Math.round ════════");
  assert("A=0 → 0", roundGrowthRate(0, 0), 0);
  assert("3/3 → 100", roundGrowthRate(3, 3), 100);
  assert("1/3 → 33 (ceil이면 34)", roundGrowthRate(1, 3), 33);
  assert("2/3 → 67 (ceil이면 67)", roundGrowthRate(2, 3), 67);
  assert("1/2 → 50", roundGrowthRate(1, 2), 50);
  assert("1/8 → 13 (ceil이면 13)", roundGrowthRate(1, 8), 13);
  assert("1/40 → 3 (ceil이면 3)", roundGrowthRate(1, 40), 3);
  assert("1/6 → 17 (ceil이면 17)", roundGrowthRate(1, 6), 17);
  assert("5/6 → 83 (ceil이면 84) ★round≠ceil", roundGrowthRate(5, 6), 83);

  console.log("\n════════ C. 실 DB A/B 동일 기준 + rate 예시 ════════");
  // info target 보유 사용자 1명 선택
  const { data: lines } = await sb
    .from("cluster4_lines").select("id").eq("part_type", "info").eq("is_active", true);
  const infoIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (infoIds.length === 0) {
    console.log("  ⚠️ active info 라인 없음 — DB 케이스 생략");
    return;
  }
  const { data: t } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,week_id")
    .eq("target_mode", "user")
    .in("line_id", infoIds)
    .limit(1);
  const sample = (t ?? [])[0] as { target_user_id: string; week_id: string } | undefined;
  if (!sample) {
    console.log("  ⚠️ info target 없음 — DB 케이스 생략");
    return;
  }
  const userId = sample.target_user_id;

  // 그 사용자의 info target 이 있는 주차들
  const { data: userTargets } = await sb
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", infoIds);
  const weekIds = [...new Set(((userTargets ?? []) as { week_id: string }[]).map((r) => r.week_id))];

  const aMap = await fetchInfoLineCountsByWeek(userId, weekIds);
  const bMap = await fetchInfoLineSuccessCountsByWeek(userId, weekIds);
  const opened = await fetchWeeksWithAnyInfoLine(weekIds);

  console.log(`  사용자 ${userId}, info 주차 ${weekIds.length}개\n`);
  console.log("  week | A(배정) | B(success) | B<=A | rate=round(B/A) | infoOpened");
  let allBLeA = true;
  for (const w of weekIds) {
    const A = aMap.get(w) ?? 0;
    const B = bMap.get(w) ?? 0;
    if (B > A) allBLeA = false;
    console.log(
      `  ${w.slice(0, 8)} | ${A} | ${B} | ${B <= A ? "✅" : "❌"} | ${roundGrowthRate(B, A)}% | ${opened.has(w) ? "Y" : "N"}`,
    );
  }
  assert("모든 주차 B<=A (A·B 동일 기준)", allBLeA, true);

  console.log("\n════════ smoke 완료 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
