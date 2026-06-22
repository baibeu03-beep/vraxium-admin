/**
 * verify-info-sentinel-http.ts  (READ-ONLY 검증)
 *   sentinel 백필 후 고객 weekly-cards 의 info 강화 상태를 3경로로 비교:
 *     direct  = getCluster4WeeklyCardsForProfileUser(uid)            (live 계산)
 *     snapshot= readWeeklyCardsSnapshot(uid)                          (저장본 = 고객 SoT)
 *     http    = GET /api/cluster4/weekly-cards?userId=uid (internal)  (실제 API 응답)
 *   → direct == snapshot == http 이면 snapshot-only 정합. demo 경로도 동일 loadWeeklyCards 사용(구조 동일).
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-info-sentinel-http.ts [uid1 uid2 ...]
 */
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE = process.env.VERIFY_BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY || "";
const DEFAULT_UIDS = [
  "14f5c826-b2cf-4a88-abda-7168f3be907d",
  "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a",
  "5c03de6a-0fbb-4b7c-bbd3-0427de8d6973",
];

type Tally = { fail: number; success: number; pending: number; na: number; cards: number };
function tally(cards: any[]): Tally {
  let fail = 0, success = 0, pending = 0, na = 0;
  for (const c of cards ?? []) {
    for (const ln of c?.lines ?? []) {
      if (ln?.partType !== "information") continue;
      if (ln.enhancementStatus === "fail") fail++;
      else if (ln.enhancementStatus === "success") success++;
      else if (ln.enhancementStatus === "pending") pending++;
      else na++;
    }
  }
  return { fail, success, pending, na, cards: (cards ?? []).length };
}
const eq = (a: Tally, b: Tally) =>
  a.fail === b.fail && a.success === b.success && a.pending === b.pending && a.na === b.na && a.cards === b.cards;
const fmt = (t: Tally) => `fail=${t.fail} success=${t.success} pending=${t.pending} na=${t.na} cards=${t.cards}`;

async function main() {
  const uids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = uids.length ? uids : DEFAULT_UIDS;
  if (!KEY) throw new Error("INTERNAL_API_KEY 미설정");
  let allOk = true;
  for (const uid of targets) {
    const directCards = await getCluster4WeeklyCardsForProfileUser(uid);
    const snap = await readWeeklyCardsSnapshot(uid);
    const snapCards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": KEY },
    });
    const body = await res.json();
    const httpCards = Array.isArray(body?.data) ? body.data : [];

    const tD = tally(directCards), tS = tally(snapCards), tH = tally(httpCards);
    const okDS = eq(tD, tS), okSH = eq(tS, tH);
    if (!okDS || !okSH) allOk = false;
    console.log(`\nuser ${uid} (http ${res.status} · snap ${snap.status})`);
    console.log(`  direct  : ${fmt(tD)}`);
    console.log(`  snapshot: ${fmt(tS)}  ${okDS ? "== direct ✓" : "≠ direct ✗"}`);
    console.log(`  http    : ${fmt(tH)}  ${okSH ? "== snapshot ✓" : "≠ snapshot ✗"}`);
  }
  console.log(`\n${allOk ? "✅ direct == snapshot == http (전 케이스 정합)" : "❌ 불일치 발견"}`);
  if (!allOk) process.exit(2);
}
main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
