/**
 * 실무 역량(competency) 강화율 분모 A 동적화 + line-row 기준 개설 판정 smoke.
 * (2026-06-02 정책 개정: 구 "competency 항상 fail / not_applicable 0건" 폐기.)
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-competency-enhancement.ts
 *
 * 검증 항목 (개정 정책):
 *   1) competency 배정 있음 + 마감 전 → pending
 *   2) competency 배정 있음 + 마감 후 → success
 *   3) competency 라인 개설됨(행 존재) + 미배정 → fail
 *   4) competency 라인 미개설(행 없음) → not_applicable   ← 개정(구: fail)
 *   5) end-to-end: competency placeholder 는 개설됨↔fail / 미개설↔not_applicable
 *   6) A = 실제 배정 수 (fetchCompetencyLineCountsByWeek)
 *   7) B <= A
 *   8) A = 0 이면 rate = 0
 *   9) info/experience 회귀 없음 (분모 헬퍼 동일 기준 확인)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import {
  roundGrowthRate,
  buildWeekAvailability,
  fetchCompetencyLineCountsByWeek,
  fetchInfoLineCountsByWeek,
  fetchExperienceLineCountsByWeek,
  fetchLineSuccessCountsByWeek,
  fetchWeeksWithAnyCompetencyLine,
} from "@/lib/lineAvailability";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

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
  console.log("════════ A. competency 강화상태 케이스 (pure func) ════════");
  // 1) 배정 있음 + 마감 전 = pending
  assert(
    "case1 배정O+마감전 → pending",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: false, hasSubmission: false, isCareer: false }).enhancementStatus,
    "pending",
  );
  // 2) 배정 있음 + 마감 후 = success (제출 무관)
  assert(
    "case2 배정O+마감후 → success",
    computeCluster4Enhancement({ hasTarget: true, deadlinePassed: true, hasSubmission: false, isCareer: false }).enhancementStatus,
    "success",
  );
  // 3)+4) (개정) competency 미배정은 info/experience 와 동일 — line-row 개설 신호로 분기.
  //    개설됨(expectedWhenMissing=true) → fail / 미개설(false) → not_applicable.
  assert(
    "case3 미배정(개설O = 행 존재) → fail",
    computeCluster4Enhancement({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: false, expectedWhenMissing: true }).enhancementStatus,
    "fail",
  );
  assert(
    "case4 미배정(미개설 = 행 없음) → not_applicable",
    computeCluster4Enhancement({ hasTarget: false, deadlinePassed: false, hasSubmission: false, isCareer: false, expectedWhenMissing: false }).enhancementStatus,
    "not_applicable",
  );

  console.log("\n════════ B. A=0 → rate=0 ════════");
  assert("A=0 → 0", roundGrowthRate(0, 0), 0);
  assert("B=1,A=1 → 100", roundGrowthRate(1, 1), 100);
  assert("B=1,A=2 → 50 (2개 배정 1개 성공)", roundGrowthRate(1, 2), 50);
  assert("B=2,A=2 → 100 (2개 배정 2개 성공, 200% 버그 없음)", roundGrowthRate(2, 2), 100);

  console.log("\n════════ C. 실 DB: competency A(배정 수) 동적 + B<=A ════════");
  const { data: lines } = await sb
    .from("cluster4_lines").select("id").eq("part_type", "competency").eq("is_active", true);
  const compIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (compIds.length === 0) {
    console.log("  ⚠️ active competency 라인 없음 (개설 전) — A/B 동적 케이스 생략");
  } else {
    const { data: t } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id,week_id")
      .eq("target_mode", "user")
      .in("line_id", compIds)
      .limit(1);
    const sample = (t ?? [])[0] as { target_user_id: string; week_id: string } | undefined;
    if (!sample) {
      console.log("  ⚠️ competency target 없음 — DB 케이스 생략");
    } else {
      const userId = sample.target_user_id;
      const { data: userTargets } = await sb
        .from("cluster4_line_targets")
        .select("week_id")
        .eq("target_mode", "user")
        .eq("target_user_id", userId)
        .in("line_id", compIds);
      const weekIds = [...new Set(((userTargets ?? []) as { week_id: string }[]).map((r) => r.week_id))];

      // A = 동적 배정 수, B = success 수
      const aMap = await fetchCompetencyLineCountsByWeek(userId, weekIds);
      const bMap = await fetchLineSuccessCountsByWeek(userId, weekIds, "competency");

      // 교차검증: A 가 실제 배정 row 수와 일치하는지 (raw count)
      const rawCount = new Map<string, number>();
      for (const r of (userTargets ?? []) as { week_id: string }[]) {
        if (weekIds.includes(r.week_id)) rawCount.set(r.week_id, (rawCount.get(r.week_id) ?? 0) + 1);
      }

      console.log(`  사용자 ${userId}, competency 주차 ${weekIds.length}개\n`);
      console.log("  week | A(헬퍼) | A(raw배정) | B(success) | A==raw | B<=A | rate=round(B/A)");
      let allBLeA = true;
      let allAeqRaw = true;
      for (const w of weekIds) {
        const A = aMap.get(w) ?? 0;
        const raw = rawCount.get(w) ?? 0;
        const B = bMap.get(w) ?? 0;
        if (B > A) allBLeA = false;
        if (A !== raw) allAeqRaw = false;
        console.log(
          `  ${w.slice(0, 8)} | ${A} | ${raw} | ${B} | ${A === raw ? "✅" : "❌"} | ${B <= A ? "✅" : "❌"} | ${roundGrowthRate(B, A)}%`,
        );
      }
      assert("A(헬퍼) == 실제 배정 수", allAeqRaw, true);
      assert("모든 주차 B<=A", allBLeA, true);
    }
  }

  console.log("\n════════ D. end-to-end: competency placeholder 개설↔fail / 미개설↔not_applicable ════════");
  // (개정) competency placeholder(lineTargetId=null, 미배정 칸)는 그 주차 competency 라인
  // 개설 여부에 따라 갈린다: 개설됨 → fail, 미개설 → not_applicable. 휴식주차는 평가 제외.
  const { data: anyTarget } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .limit(1);
  const probeUser = (anyTarget ?? [])[0] as { target_user_id: string } | undefined;
  if (!probeUser) {
    console.log("  ⚠️ line_target 보유 사용자 없음 — end-to-end 생략");
  } else {
    const cards = await getCluster4WeeklyCardsForProfileUser(probeUser.target_user_id);
    const weekIds = cards.map((c) => c.weekId).filter((w): w is string => Boolean(w));
    const openedComp = await fetchWeeksWithAnyCompetencyLine(weekIds);
    let compLineCount = 0;
    let placeholderCount = 0;
    let consistent = 0;
    const statusTally: Record<string, number> = {};
    for (const card of cards) {
      for (const line of card.lines) {
        if (line.partType !== "competency") continue;
        compLineCount += 1;
        statusTally[line.enhancementStatus] = (statusTally[line.enhancementStatus] ?? 0) + 1;
        // placeholder(미배정 칸)만 개설↔상태 일관성 검사. 휴식주차는 모든 part not_applicable.
        if (line.lineTargetId === null && card.weekId && !card.isRestWeek) {
          placeholderCount += 1;
          const want = openedComp.has(card.weekId) ? "fail" : "not_applicable";
          if (line.enhancementStatus === want) consistent += 1;
          else console.log(`    ❌ week=${card.weekId.slice(0, 8)} opened=${openedComp.has(card.weekId)} got=${line.enhancementStatus} want=${want}`);
        }
      }
    }
    console.log(`  사용자 ${probeUser.target_user_id}`);
    console.log(`  competency 라인 ${compLineCount}건, 상태 분포: ${JSON.stringify(statusTally)}`);
    console.log(`  placeholder ${placeholderCount}건 중 개설↔상태 일관 ${consistent}건`);
    assert("competency placeholder 개설↔fail / 미개설↔not_applicable 100%", consistent, placeholderCount);
    assert("competency 라인이 1건 이상 스캔됨", compLineCount > 0, true);
  }

  console.log("\n════════ E. info/experience 분모 헬퍼 회귀 (동일 기준 확인) ════════");
  // info/experience 헬퍼 시그니처/동작 변경 없음 — 호출만으로 회귀 smoke (예외 없으면 통과).
  const probe = await Promise.all([
    fetchInfoLineCountsByWeek("00000000-0000-0000-0000-000000000000", []),
    fetchExperienceLineCountsByWeek("00000000-0000-0000-0000-000000000000", []),
  ]);
  assert("info/experience 헬퍼 정상 호출 (빈 weekIds → 빈 map)", [probe[0].size, probe[1].size], [0, 0]);

  console.log("\n════════ F. buildWeekAvailability competency A 동적화 (이력서/weekly 공용) ════════");
  const wA = "week-A";
  const compMap2 = new Map<string, number>([[wA, 2]]);
  const compMap0 = new Map<string, number>();
  // competencyMap 제공 → ability = 배정 수 (2)
  assert(
    "competencyMap 제공 시 ability=배정수(2)",
    buildWeekAvailability(wA, new Map(), new Map(), "oranke", new Map(), compMap2).ability,
    2,
  );
  // competencyMap 제공 + 배정 0 → ability=0 (하드코딩 1 아님)
  assert(
    "competencyMap 제공 + 배정0 → ability=0 (NOT 1)",
    buildWeekAvailability(wA, new Map(), new Map(), "oranke", new Map(), compMap0).ability,
    0,
  );
  // competencyMap 미제공(레거시 호출) → 기존 상수 1 폴백 (하위호환)
  assert(
    "competencyMap 미제공 → 상수 1 폴백 (하위호환)",
    buildWeekAvailability(wA, new Map(), new Map(), "oranke", new Map()).ability,
    1,
  );

  console.log("\n════════ G. end-to-end 휴식 주차: competency fail 아님 ════════");
  // 휴식(personal_rest/official_rest) 주차를 가진 사용자 1명 선택.
  const { data: restRows } = await sb
    .from("user_week_statuses")
    .select("user_id,status")
    .in("status", ["personal_rest", "official_rest"])
    .limit(200);
  const restUser = (restRows ?? []).find((r) => Boolean((r as { user_id: string }).user_id)) as
    | { user_id: string }
    | undefined;
  if (!restUser) {
    console.log("  ⚠️ 휴식 주차 보유 사용자 없음 — 생략");
  } else {
    const cards = await getCluster4WeeklyCardsForProfileUser(restUser.user_id);
    let restCompFail = 0;
    let restComp = 0;
    let normalComp = 0;
    let normalCompNa = 0;
    const restStatusTally: Record<string, number> = {};
    for (const card of cards) {
      for (const line of card.lines) {
        if (line.partType !== "competency") continue;
        if (card.isRestWeek) {
          restComp += 1;
          restStatusTally[line.enhancementStatus] = (restStatusTally[line.enhancementStatus] ?? 0) + 1;
          if (line.enhancementStatus === "fail") restCompFail += 1;
        } else {
          normalComp += 1;
          if (line.enhancementStatus === "not_applicable") normalCompNa += 1;
        }
      }
    }
    console.log(`  사용자 ${restUser.user_id}`);
    console.log(`  휴식주차 competency ${restComp}건, 상태 분포: ${JSON.stringify(restStatusTally)}`);
    console.log(`  일반주차 competency ${normalComp}건 (그 중 not_applicable ${normalCompNa}건 — 개정 정책상 허용)`);
    // 개정 정책: 일반주차도 competency 라인 미개설이면 not_applicable 허용 (구 "0건" 단언 폐기).
    assert("휴식 주차 competency fail 0건", restCompFail, 0);
    assert("휴식 주차 competency 1건 이상 스캔됨", restComp > 0, true);
  }

  console.log("\n════════ smoke 완료 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
