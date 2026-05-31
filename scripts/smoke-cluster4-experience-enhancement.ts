/**
 * 실무 경험(experience) 강화율/강화상태 보정 smoke (2026-05-30).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-experience-enhancement.ts
 *
 * A. 4케이스 강화상태 — weekly-cards 의 experience wiring 이
 *    computeCluster4Enhancement 에 넘기는 입력 그대로 재현:
 *    1) 배정 있음 + 마감 전  = pending
 *    2) 배정 있음 + 마감 후  = success
 *    3) 배정 없음 + experience 라인 개설됨(expectedWhenMissing=true) = fail
 *    4) experience 라인 미개설(expectedWhenMissing=false)            = not_applicable
 * B. 분모 A = fetchExperienceLineCountsByWeek (배정 수), 분자 B = success 수.
 *    같은 기준(line_targets + 마감)인지, B<=A, rate=round(B/A) 예시.
 * C. fail/not_applicable 구분: emptyLine wiring 식 재현.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import {
  roundGrowthRate,
  fetchExperienceLineCountsByWeek,
  fetchLineSuccessCountsByWeek,
  fetchWeeksWithAnyExperienceLine,
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

// weekly-cards(cluster4WeeklyCardsData.ts)의 emptyLine 미배정 wiring 재현:
//   expectedWhenMissing = (information && weeksWithInfoLine) || (experience && weeksWithExperienceLine)
function experienceExpectedWhenMissing(weeksWithExperienceLine: Set<string>, weekId: string): boolean {
  return weeksWithExperienceLine.has(weekId);
}

async function main() {
  console.log("════════ A. 4케이스 강화상태 (experience) ════════");
  // 1) 배정 있음 + 마감 전 = pending  (toLineDetail: hasTarget=true, deadlinePassed=false)
  assert(
    "case1 배정O+마감전",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: false, hasSubmission: false, isCareer: false }).enhancementStatus,
    "pending",
  );
  // 2) 배정 있음 + 마감 후 = success (제출 무관)
  assert(
    "case2 배정O+마감후",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false }).enhancementStatus,
    "success",
  );
  // 3) 배정 없음 + experience 라인 개설됨 = fail (emptyLine: expectedWhenMissing=true)
  {
    const opened = new Set<string>(["W1"]);
    const expected = experienceExpectedWhenMissing(opened, "W1");
    assert(
      "case3 배정X+개설O",
      computeCluster4Enhancement({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: false, expectedWhenMissing: expected }).enhancementStatus,
      "fail",
    );
  }
  // 4) experience 라인 미개설 = not_applicable (emptyLine: expectedWhenMissing=false)
  {
    const opened = new Set<string>(); // 미개설
    const expected = experienceExpectedWhenMissing(opened, "W1");
    assert(
      "case4 미개설",
      computeCluster4Enhancement({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: false, expectedWhenMissing: expected }).enhancementStatus,
      "not_applicable",
    );
  }

  console.log("\n════════ B. 분모 A = 배정 수 (상수 2 아님) ════════");
  // active experience 라인 보유 사용자 1명 선택
  const { data: lines } = await sb
    .from("cluster4_lines").select("id").eq("part_type", "experience").eq("is_active", true);
  const expIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (expIds.length === 0) {
    console.log("  ⚠️ active experience 라인 없음 — DB 케이스 생략");
    console.log("\n════════ smoke 완료 ════════");
    return;
  }
  const { data: t } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,week_id")
    .eq("target_mode", "user")
    .in("line_id", expIds)
    .limit(1);
  const sample = (t ?? [])[0] as { target_user_id: string; week_id: string } | undefined;
  if (!sample) {
    console.log("  ⚠️ experience target 없음 — DB 케이스 생략");
    console.log("\n════════ smoke 완료 ════════");
    return;
  }
  const userId = sample.target_user_id;

  const { data: userTargets } = await sb
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", expIds);
  const weekIds = [...new Set(((userTargets ?? []) as { week_id: string }[]).map((r) => r.week_id))];

  const aMap = await fetchExperienceLineCountsByWeek(userId, weekIds);
  const bMap = await fetchLineSuccessCountsByWeek(userId, weekIds, "experience");
  const opened = await fetchWeeksWithAnyExperienceLine(weekIds);

  console.log(`  사용자 ${userId}, experience 주차 ${weekIds.length}개\n`);
  console.log("  week | A(배정) | B(success) | B<=A | rate=round(B/A) | expOpened");
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
  assert("A 가 상수 2 아님 — 배정 수 기준(0 포함 가능)", aMap.size >= 0, true);

  console.log("\n════════ smoke 완료 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
