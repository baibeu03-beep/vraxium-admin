// 성장 중단 정책 direct 검증 — loadGrowthStopInfo + truncateCardsForGrowthStop.
//   npx tsx --env-file=.env.local scripts/verify-growth-stop-policy.ts
import { listTestUsers } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import {
  loadGrowthStopInfo,
  truncateCardsForGrowthStop,
} from "@/lib/cluster4GrowthStopPolicy";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

function counts(cards: Cluster4WeeklyCardDto[]): string {
  const c: Record<string, number> = {};
  for (const x of cards) c[x.userWeekStatus] = (c[x.userWeekStatus] ?? 0) + 1;
  return JSON.stringify(c);
}

async function main() {
  const users = await listTestUsers();
  const stopped = users.filter((u) =>
    ["suspended", "paused"].includes(u.growthStatus ?? ""),
  );
  const active = users.filter((u) => (u.growthStatus ?? "active") === "active");
  const sample = [...stopped.slice(0, 4), ...active.slice(0, 2)];

  let pass = true;
  for (const u of sample) {
    const info = await loadGrowthStopInfo(u.userId);

    // snapshot 경로(일반 모드와 동일 입력).
    const snap = await readWeeklyCardsSnapshot(u.userId);
    const snapCards =
      snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const snapTrunc = truncateCardsForGrowthStop(snapCards, info.isStopped);

    // summer-sim 경로(mode=test 와 동일 입력 — 현재 주차 running 노출 가능).
    const simCards = await getCluster4WeeklyCardsForProfileUser(u.userId, {
      effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM,
    });
    const simTrunc = truncateCardsForGrowthStop(simCards, info.isStopped);

    const removedSnap = snapCards.length - snapTrunc.length;
    const removedSim = simCards.length - simTrunc.length;

    // 불변식: ① 중단 아니면 truncation 0. ② 제거된 카드는 모두 running/tallying.
    //         ③ 남은 카드에 running/tallying 없음(중단 시).
    if (!info.isStopped && (removedSnap !== 0 || removedSim !== 0)) pass = false;
    if (info.isStopped) {
      const leftover = simTrunc.filter(
        (c) => c.userWeekStatus === "running" || c.userWeekStatus === "tallying",
      ).length;
      if (leftover !== 0) pass = false;
    }

    console.log(`── ${u.name} (${u.organizationSlug}) gs=${u.growthStatus}`);
    console.log(
      `   growthInfo: status=${info.status} growthStatus=${info.growthStatus} isStopped=${info.isStopped}`,
    );
    console.log(
      `   snapshot: ${counts(snapCards)} → trunc ${counts(snapTrunc)} (removed ${removedSnap})`,
    );
    console.log(
      `   summer-sim: ${counts(simCards)} → trunc ${counts(simTrunc)} (removed ${removedSim})`,
    );
    console.log("");
  }
  // ── 합성 단위 증명: truncation 이 미확정(running/tallying)만 제거하고 확정은 보존 ──
  const synth = [
    { userWeekStatus: "success" },
    { userWeekStatus: "fail" },
    { userWeekStatus: "personal_rest" },
    { userWeekStatus: "official_rest" },
    { userWeekStatus: "tallying" },
    { userWeekStatus: "running" },
  ] as unknown as Cluster4WeeklyCardDto[];
  const stoppedOut = truncateCardsForGrowthStop(synth, true);
  const activeOut = truncateCardsForGrowthStop(synth, false);
  const stoppedOk =
    stoppedOut.length === 4 &&
    stoppedOut.every(
      (c) => c.userWeekStatus !== "running" && c.userWeekStatus !== "tallying",
    );
  const activeOk = activeOut.length === 6;
  if (!stoppedOk || !activeOk) pass = false;
  console.log(
    `synthetic: stopped 6→${stoppedOut.length} (expect 4, ${stoppedOk ? "ok" : "FAIL"}), ` +
      `active 6→${activeOut.length} (expect 6, ${activeOk ? "ok" : "FAIL"})`,
  );

  console.log(pass ? "INVARIANTS: PASS" : "INVARIANTS: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
