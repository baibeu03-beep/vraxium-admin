/**
 * (READ-ONLY 진단) getWeeklyGrowth 비결정성 규명.
 *   파리티 하네스가 잡은 현상: 같은 userId 로 2회 연속 호출 시 seasonGrowthRates 가 달라짐.
 *   computeSeasonGrowthRates 는 순수 함수 → 원인은 weeklyCards(availableLines) 또는 카드 순서.
 *
 *   npx tsx --env-file=.env.local scripts/diag-weekly-growth-nondeterminism.ts <userIdPrefix>
 */
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const prefix = process.argv[2] ?? "5c5bd454";

function line(s = "") {
  console.log(s);
}

async function main() {
  const { data } = await supabaseAdmin.from("user_profiles").select("user_id").limit(4000);
  const uid = ((data ?? []) as { user_id: string }[]).find((r) => r.user_id.startsWith(prefix))?.user_id;
  if (!uid) {
    line(`✗ userId prefix ${prefix} 없음`);
    return;
  }
  line(`▶ user=${uid}`);

  const runs: Array<{ order: string[]; rates: string[]; availByWeek: string[] }> = [];
  for (let i = 0; i < 3; i++) {
    const g = await getWeeklyGrowth(uid);
    if (!g) {
      line("✗ growth null");
      return;
    }
    runs.push({
      order: g.seasonGrowthRates.map((r) => r.seasonKey),
      rates: g.seasonGrowthRates.map(
        (r) => `${r.seasonKey}: ${r.totalCompleted}/${r.totalAvailable} = ${r.rate}%`,
      ),
      availByWeek: g.weeklyCards.map(
        (c) =>
          `${c.seasonKey ?? "-"}#${c.weekNumber}${c.isTransition ? "(T)" : ""}: ${c.weeklyGrowth.completedLines}/${c.weeklyGrowth.availableLines}`,
      ),
    });
  }

  for (let i = 0; i < runs.length; i++) {
    line();
    line(`── run ${i + 1} ──`);
    line(`  seasonGrowthRates 순서: ${runs[i].order.join(" , ")}`);
    for (const r of runs[i].rates) line(`    ${r}`);
  }

  line();
  line("═══ 판정 ═══");
  const orderSame = runs.every((r) => r.order.join("|") === runs[0].order.join("|"));
  const ratesSame = runs.every((r) => r.rates.join("|") === runs[0].rates.join("|"));
  const multisetSame = runs.every(
    (r) => [...r.rates].sort().join("|") === [...runs[0].rates].sort().join("|"),
  );
  line(`  seasonGrowthRates 배열 순서 동일 : ${orderSame ? "예" : "❌ 아니오(비결정 순서)"}`);
  line(`  seasonGrowthRates 값 동일(순서포함): ${ratesSame ? "예" : "❌ 아니오"}`);
  line(`  seasonGrowthRates 멀티셋 동일     : ${multisetSame ? "예 → 순서만 비결정" : "❌ 아니오 → 값 자체가 비결정"}`);

  // 주차별 availableLines 비교(값 비결정이면 어느 주차인지 특정).
  const w0 = runs[0].availByWeek;
  for (let i = 1; i < runs.length; i++) {
    const wi = runs[i].availByWeek;
    if (w0.join("|") === wi.join("|")) continue;
    line();
    line(`  ▶ run1 vs run${i + 1} 주차별 completed/available 차이:`);
    const max = Math.max(w0.length, wi.length);
    for (let k = 0; k < max; k++) {
      if (w0[k] !== wi[k]) line(`     [${k}] run1="${w0[k] ?? "<none>"}"  run${i + 1}="${wi[k] ?? "<none>"}"`);
    }
  }
  line();
  line("완료(read-only).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
