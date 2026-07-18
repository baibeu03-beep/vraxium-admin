/**
 * Weekly Ranking slim projection ↔ fat weekly-cards parity 검증(읽기 전용).
 *
 *   node scripts/verify-weekly-ranking-projection-parity.mjs
 *
 * 전제: admin dev(:3000) 기동. INTERNAL_API_KEY 로 인증.
 * 대상 userId: 인자/USER_IDS(csv) → 없으면 크루 /api/weekly-league 3개 조직 showcase 에서 수집.
 *
 * 검증 내용(핵심): 각 userId 에 대해
 *   A = GET /api/cluster4/weekly-cards?userId=  (fat) → 크루 metricFromCard 적용
 *   B = POST /api/cluster4/weekly-cards-projection (slim) → 동일 metricFromCard 적용
 * A 와 B 가 weekId 집합·모든 metricFromCard 스칼라까지 완전히 동일해야 한다.
 * (slim 은 fat 카드에서 랭킹 필드만 얕게 뽑은 view 이므로 계산 재실행 없이 byte-parity 여야 한다.)
 */
const ADMIN = process.env.ADMIN_BASE ?? "http://localhost:3000";
const CREW = process.env.CREW_BASE ?? "http://localhost:3001";
const KEY = process.env.INTERNAL_API_KEY ?? "";
const MODE = process.env.MODE ?? "test";

// ── 크루 lib/weekly-league.ts 의 rateValue + metricFromCard 와 동일(검증 기준) ──
const rateValue = (rate) => {
  if (typeof rate?.rate === "number" && Number.isFinite(rate.rate)) return rate.rate;
  const total = Number(rate?.total) || 0;
  const count = Number(rate?.count) || 0;
  return total > 0 ? Math.round((count / total) * 100) : 0;
};
const metricFromCard = (card) => ({
  cumulativeSuccessWeeks: Math.max(0, Number(card.accumulatedApprovedWeeks) || 0),
  weeklyGrowthRate:
    card.growthRate != null
      ? rateValue(card.growthRate)
      : typeof card.weeklyGrowthRate === "number"
        ? card.weeklyGrowthRate
        : 0,
  infoRate: rateValue(card.infoRate),
  experienceRate: rateValue(card.experienceRate),
  competencyRate: rateValue(card.competencyRate),
  careerRate: rateValue(card.careerRate),
});
const buildMap = (cards) => Object.fromEntries(cards.map((c) => [c.weekId, metricFromCard(c)]));

async function collectUserIds() {
  const argIds = process.argv.slice(2).join(",") || process.env.USER_IDS || "";
  if (argIds.trim()) return [...new Set(argIds.split(",").map((s) => s.trim()).filter(Boolean))];
  const ids = new Set();
  for (const org of ["phalanx", "encre", "oranke"]) {
    try {
      const r = await fetch(`${CREW}/api/weekly-league/?org=${org}`);
      const j = await r.json();
      for (const c of j.cards ?? []) for (const x of c.crewRankShowcase ?? []) ids.add(x.userId);
    } catch (e) {
      console.warn(`  (crew ${org} 수집 실패: ${e.message})`);
    }
  }
  return [...ids];
}

const run = async () => {
  if (!KEY) { console.error("✗ INTERNAL_API_KEY 필요 (--env-file=.env.local)"); process.exit(1); }
  const userIds = await collectUserIds();
  if (userIds.length === 0) { console.error("✗ 대상 userId 없음"); process.exit(1); }
  console.log(`대상 userId: ${userIds.length}명 | admin=${ADMIN} mode=${MODE}`);

  // B: slim projection 1 POST
  const pr = await fetch(`${ADMIN}/api/cluster4/weekly-cards-projection`, {
    method: "POST",
    headers: { "x-internal-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ userIds, mode: MODE }),
  });
  if (!pr.ok) { console.error(`✗ projection HTTP ${pr.status}`); process.exit(1); }
  const batch = await pr.json();
  const slimByUser = new Map((batch.users ?? []).map((u) => [u.userId, u]));

  let checked = 0, userFail = 0, metricFail = 0;
  for (const uid of userIds) {
    // A: fat GET
    const fr = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}&mode=${MODE}`, {
      headers: { "x-internal-api-key": KEY },
    });
    const fat = await fr.json();
    const fatOk = fat.success === true && Array.isArray(fat.data);
    const slim = slimByUser.get(uid);
    const slimOk = slim?.ok === true;
    if (fatOk !== slimOk) { userFail++; console.error(`  ✗ ${uid.slice(0, 8)} skip-decision differs: fat=${fatOk} slim=${slimOk}`); continue; }
    if (!fatOk) continue; // both skip → identical
    const a = buildMap(fat.data), b = buildMap(slim.cards);
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    if (JSON.stringify(ak) !== JSON.stringify(bk)) { userFail++; console.error(`  ✗ ${uid.slice(0, 8)} weekId set differs (${ak.length} vs ${bk.length})`); continue; }
    for (const wk of ak) {
      checked++;
      if (JSON.stringify(a[wk]) !== JSON.stringify(b[wk])) {
        metricFail++;
        if (metricFail <= 10) console.error(`  ✗ ${uid.slice(0, 8)}|${wk.slice(0, 8)} fat=${JSON.stringify(a[wk])} slim=${JSON.stringify(b[wk])}`);
      }
    }
  }
  console.log(`검증 metrics=${checked} | userFail=${userFail} metricFail=${metricFail}`);
  if (userFail === 0 && metricFail === 0) console.log("✓ PARITY: metricFromCard(slim) === metricFromCard(fat) — 전 유저/전 주차 동일");
  else { console.error("✗ PARITY 실패"); process.exit(1); }
};
run();
