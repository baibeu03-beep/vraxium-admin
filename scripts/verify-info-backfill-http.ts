// HTTP==snapshot==direct 검증 — info target 백필 후. dev 서버(localhost:3000) 필요.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;

function infoSuccess(cards: any[]): number {
  let n = 0;
  for (const c of cards ?? []) for (const l of c.lines ?? []) if (l.partType === "information" && l.enhancementStatus === "success") n++;
  return n;
}
async function snap(uid: string): Promise<any[]> {
  const s = await readWeeklyCardsSnapshot(uid);
  return s.status === "hit" || s.status === "stale" ? (s.cards as any[]) : [];
}

async function main() {
  const { sample } = JSON.parse(readFileSync("claudedocs/encre-info-backfill-sample-users.json", "utf8")) as { sample: string[] };
  console.log(`=== HTTP==snapshot==direct 검증 (${sample.length}명) BASE=${BASE} ===\n`);
  let httpEqSnap = 0, httpEqDirect = 0, ok = 0;
  for (const uid of sample) {
    const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": KEY } });
    const body = await res.json().catch(() => null);
    // 응답 envelope: cards 배열은 body.data (그 자체가 카드 배열).
    const httpCards = (Array.isArray(body?.data) ? body.data : body?.cards ?? []) as any[];
    const sCards = await snap(uid);
    const dCards = await getCluster4WeeklyCardsForProfileUser(uid);
    const h = infoSuccess(httpCards), s = infoSuccess(sCards), d = infoSuccess(dCards);
    const eqHS = h === s, eqHD = h === d;
    if (eqHS) httpEqSnap++;
    if (eqHD) httpEqDirect++;
    if (eqHS && eqHD) ok++;
    console.log(`  ${uid.slice(0, 8)} status=${res.status} info-success HTTP=${h} snap=${s} direct=${d} ${eqHS && eqHD ? "✅" : "❌"}`);
  }
  console.log(`\nHTTP==snapshot ${httpEqSnap}/${sample.length} · HTTP==direct ${httpEqDirect}/${sample.length} · 3자 일치 ${ok}/${sample.length}`);
  console.log(ok === sample.length ? "✅ direct == HTTP == snapshot 전부 일치" : "❌ 불일치 존재");
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
