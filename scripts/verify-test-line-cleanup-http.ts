/**
 * 삭제 후 검증: 영향 테스트유저 12명에 대해 direct == HTTP 확인.
 *   npx tsx --env-file=.env.local scripts/verify-test-line-cleanup-http.ts
 *
 * direct = getCluster4WeeklyCardsForProfileUser(live)
 * http   = GET /api/cluster4/weekly-cards?userId=<id> (x-internal-api-key, snapshot)
 * 재계산 후 snapshot == live → 두 결과의 주차별 강화율/라인 투영이 일치해야 한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "fs";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;

// 카드 → 비교용 안정 투영(주차별 강화 분자/분모 + 라인 partType별 분자/분모).
function project(cards: any[]) {
  return cards
    .map((c) => ({
      season: c.seasonKey ?? null,
      week: c.weekNumber,
      g: `${c.growthNumerator}/${c.growthDenominator}`,
      lines: (c.lines ?? [])
        .map((l: any) => `${l.partType}:${l.numerator}/${l.denominator}`)
        .sort(),
    }))
    .sort((a, b) => String(a.season).localeCompare(String(b.season)) || a.week - b.week);
}

async function httpCards(userId: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`success=false ${JSON.stringify(json.error)}`);
  return json.data as any[];
}

async function main() {
  const json = JSON.parse(
    readFileSync("claudedocs/diag-test-line-cleanup-2026spring-candidates.json", "utf8"),
  );
  const users: string[] = json.affectedUserIds;
  console.log(`direct == HTTP 검증: ${users.length}명\n`);

  let pass = 0;
  for (const u of users) {
    try {
      const [direct, http] = await Promise.all([
        getCluster4WeeklyCardsForProfileUser(u),
        httpCards(u),
      ]);
      const pd = JSON.stringify(project(direct));
      const ph = JSON.stringify(project(http));
      const eq = pd === ph;
      if (eq) pass++;
      console.log(
        `  ${u.slice(0, 8)}: direct=${direct.length}card http=${http.length}card | direct==HTTP ${eq ? "✅" : "❌"}`,
      );
      if (!eq) {
        console.log("    direct:", pd.slice(0, 300));
        console.log("    http  :", ph.slice(0, 300));
      }
    } catch (e) {
      console.log(`  ${u.slice(0, 8)}: ❌ ${(e as Error).message}`);
    }
  }
  console.log(`\ndirect == HTTP: ${pass}/${users.length} 일치`);
  if (pass !== users.length) process.exit(1);
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
