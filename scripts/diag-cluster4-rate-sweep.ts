/**
 * 전체 테스트 유저 sweep — not_applicable 누수 / 카드분모 / stale snapshot 집계 + 비제로 예시.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-rate-sweep.ts
 */
import { listTestUsers } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { computeSeasonAreaProgress } from "@/lib/cluster4SeasonCircles";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

function sk(): string | null {
  const s = getSeasonForDate(new Date().toISOString().slice(0, 10));
  return s ? seasonDbKey(s) : null;
}

function rateShape(cards: Cluster4WeeklyCardDto[]) {
  return JSON.stringify(
    cards.map((c) => ({
      w: c.weekNumber,
      r: c.weeklyGrowthRate,
      n: c.growthNumerator,
      d: c.growthDenominator,
      L: (c.lines ?? []).map((l) => [l.partType, l.enhancementStatus, l.numerator, l.denominator]),
    })),
  );
}

// 카드 한 장: not_applicable 라인이 분모/분자에 들어갔는지 + 카드분모=Σ(non-NA part).
function auditCard(c: Cluster4WeeklyCardDto) {
  const seen = new Set<string>();
  let den = 0,
    num = 0,
    leak = 0;
  for (const l of c.lines ?? []) {
    if (seen.has(l.partType)) continue;
    seen.add(l.partType);
    const na = l.enhancementStatus === "not_applicable";
    if (na) {
      if (l.numerator != null || l.denominator != null) leak++;
      continue;
    }
    if (l.denominator != null) den += l.denominator;
    if (l.numerator != null) num += l.numerator;
  }
  const mismatch =
    !c.isRestWeek && (c.growthDenominator !== den || c.growthNumerator !== num);
  return { leak, mismatch, num };
}

async function main() {
  const users = await listTestUsers();
  console.log(`[sweep] users=${users.length}`);
  let scanned = 0,
    totalLeak = 0,
    totalMismatch = 0,
    staleUsers = 0;
  const leakUsers: string[] = [];
  const mismatchUsers: string[] = [];
  const staleList: string[] = [];
  const nonZero: { userId: string; name: string; completed: number }[] = [];

  for (const u of users) {
    let live: Cluster4WeeklyCardDto[];
    try {
      live = await getCluster4WeeklyCardsForProfileUser(u.userId);
    } catch {
      continue;
    }
    scanned++;
    let userCompleted = 0;
    for (const c of live) {
      const a = auditCard(c);
      totalLeak += a.leak;
      if (a.leak) leakUsers.push(`${u.name}:${c.weekNumber}`);
      if (a.mismatch) {
        totalMismatch++;
        mismatchUsers.push(`${u.name}:${c.weekNumber}`);
      }
      userCompleted += a.num;
    }
    if (userCompleted > 0)
      nonZero.push({ userId: u.userId, name: u.name, completed: userCompleted });

    // stale: stored snapshot != live recompute.
    const snap = await readWeeklyCardsSnapshot(u.userId);
    if (snap.status === "hit" || snap.status === "stale") {
      if (rateShape(snap.cards) !== rateShape(live)) {
        staleUsers++;
        staleList.push(`${u.name}(${snap.status === "stale" ? snap.reason : "hit-but-diff"})`);
      }
    }
  }

  console.log(`\n──────── SWEEP 결과 (scanned=${scanned}) ────────`);
  console.log(`  not_applicable 누수 라인 총: ${totalLeak} ${totalLeak === 0 ? "✅" : "❌ " + leakUsers.slice(0, 20).join(", ")}`);
  console.log(`  카드분모≠Σ(non-NA) 총: ${totalMismatch} ${totalMismatch === 0 ? "✅" : "❌ " + mismatchUsers.slice(0, 20).join(", ")}`);
  console.log(`  stale(snapshot≠live) 유저: ${staleUsers} ${staleUsers === 0 ? "✅" : "❌ " + staleList.slice(0, 30).join(", ")}`);

  nonZero.sort((a, b) => b.completed - a.completed);
  console.log(`\n  비제로(completed>0) 유저 ${nonZero.length}명. 상위:`);
  for (const n of nonZero.slice(0, 8))
    console.log(`     ${n.name.padEnd(12)} completed=${n.completed}  userId=${n.userId}`);

  // 상위 1명의 area-7 rate/count/total 구체 예시.
  if (nonZero[0]) {
    const top = await getCluster4WeeklyCardsForProfileUser(nonZero[0].userId);
    const prog = computeSeasonAreaProgress(top, sk());
    console.log(`\n  [예시] ${nonZero[0].name} area-7 4허브 (rate / count / total):`);
    for (const p of prog)
      console.log(`     ${p.label.padEnd(6)} rate=${String(p.rate).padStart(3)}%  count=${p.earned}  total=${p.total}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
