/**
 * Phase 1 검증 — HTTP(weekly-cards) == direct(card) == direct(unified-growth).
 *
 *   (dev 서버가 localhost:3000 에서 떠 있어야 함)
 *   npx tsx --env-file=.env.local scripts/verify-cluster4-sot-http.ts
 *
 * 삼각 비교(주차별 growthNumerator/growthDenominator):
 *   A = HTTP  /api/cluster4/weekly-cards?userId= (internal key) — 스냅샷 서빙 경로
 *   B = direct getCluster4WeeklyCardsForProfileUser            — 카드 SoT
 *   C = direct getUnifiedWeeklyGrowth().weeklyCards[].weeklyGrowth — 성장 화면 SoT
 * B==C 는 강화율 SoT 통일(카드=성장), A==B 는 HTTP 서빙 충실도(스냅샷 최신).
 */
import { createClient } from "@supabase/supabase-js";
import {
  getCluster4WeeklyCardsForProfileUser,
  getUnifiedWeeklyGrowth,
} from "@/lib/cluster4WeeklyCardsData";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const internalKey = process.env.INTERNAL_API_KEY!;
const sb = createClient(url, key);
const BASE = process.env.VERIFY_BASE ?? "http://localhost:3000";
const CAP = Number(process.env.VERIFY_USER_CAP ?? 12);

async function pickUsers(): Promise<string[]> {
  const set = new Set<string>();
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(2000);
  for (const r of data ?? []) if (r.target_user_id) set.add(r.target_user_id as string);
  return [...set].slice(0, CAP);
}

type WD = { num: number; den: number };
function keyOf(c: any): string {
  return c.weekId;
}
function httpMap(cards: any[]): Map<string, WD> {
  return new Map(
    (cards ?? [])
      .filter((c) => c.weekId)
      .map((c) => [c.weekId, { num: Number(c.growthNumerator ?? 0), den: Number(c.growthDenominator ?? 0) }]),
  );
}
function growthMap(cards: any[]): Map<string, WD> {
  return new Map(
    (cards ?? [])
      .filter((c) => c.weekId)
      .map((c) => [
        c.weekId,
        { num: Number(c.weeklyGrowth?.completedLines ?? 0), den: Number(c.weeklyGrowth?.availableLines ?? 0) },
      ]),
  );
}
function diff(a: Map<string, WD>, b: Map<string, WD>): number {
  let n = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k);
    const y = b.get(k);
    if ((x?.num ?? 0) !== (y?.num ?? 0) || (x?.den ?? 0) !== (y?.den ?? 0)) n++;
  }
  return n;
}

async function main() {
  const users = await pickUsers();
  console.log(`users: ${users.length} | base=${BASE}`);
  let abTotal = 0, bcTotal = 0, acTotal = 0;
  const samples: any[] = [];
  for (const uid of users) {
    const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": internalKey },
    });
    if (res.status !== 200) { console.log(`  ${uid}: HTTP ${res.status} (skip)`); continue; }
    const json = await res.json();
    const A = httpMap(json.data ?? []);
    const [cardDirect, growthDirect] = await Promise.all([
      getCluster4WeeklyCardsForProfileUser(uid),
      getUnifiedWeeklyGrowth(uid),
    ]);
    const B = httpMap(cardDirect);
    const C = growthMap(growthDirect?.weeklyCards ?? []);
    const ab = diff(A, B), bc = diff(B, C), ac = diff(A, C);
    abTotal += ab; bcTotal += bc; acTotal += ac;
    if (bc > 0 || ab > 0) samples.push({ uid, ab_httpVsDirectCard: ab, bc_cardVsGrowth: bc, ac });
    console.log(`  ${uid}: A(http)=${A.size} B(card)=${B.size} C(growth)=${C.size} | A==B diff=${ab} B==C diff=${bc}`);
  }
  console.log("\n==== SUMMARY ====");
  console.log(`A==B (HTTP card vs direct card) total diffs: ${abTotal}  (>0 = 스냅샷 stale, 통일과 무관)`);
  console.log(`B==C (direct card vs direct growth) total diffs: ${bcTotal}  (0 이어야 = SoT 통일 성공)`);
  console.log(`A==C (HTTP card vs direct growth) total diffs: ${acTotal}`);
  if (samples.length) console.log("samples:", JSON.stringify(samples.slice(0, 10), null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
