/**
 * 카드 역할 배지 — direct == HTTP == snapshot 검증.
 *   npx tsx --env-file=.env.local scripts/verify-card-role-badge-http.ts
 *   1) recompute snapshot(직접) → direct 카드
 *   2) HTTP /api/cluster4/weekly-cards?userId (internal key) → snapshot 저장본
 *   3) weekId별 roleLabel direct == HTTP 비교
 *   4) 시즌별 배지 + 이력서 position 대조
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { computeSeasonRecords } from "@/lib/cluster1ResumeData";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;

const NAMES = ["유효진", "오유나", "유재희"];

async function httpCards(uid: string): Promise<any[] | null> {
  try {
    const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": KEY } });
    const j = await r.json();
    return Array.isArray(j?.data) ? j.data : null;
  } catch (e) { console.log("http err", e); return null; }
}

async function main() {
  for (const name of NAMES) {
    const { data: p } = await sb.from("user_profiles").select("user_id").ilike("display_name", name).limit(1);
    const uid = (p as any)?.[0]?.user_id; if (!uid) { console.log(`${name} 없음`); continue; }

    const direct = await recomputeAndStoreWeeklyCardsSnapshot(uid); // writes snapshot v25
    // second HTTP read should be hit (fresh)
    let http = await httpCards(uid);
    // version_mismatch path may return old once; but we just wrote fresh v25 → should be hit.
    const dMap = new Map(direct.map((c:any)=>[c.weekId, c.roleLabel]));
    const hMap = new Map((http??[]).map((c:any)=>[c.weekId, c.roleLabel]));
    let mismatch = 0, compared = 0;
    for (const [wid, rl] of dMap) {
      if (!wid) continue;
      compared++;
      if (hMap.get(wid) !== rl) { mismatch++; if (mismatch<=5) console.log(`   ✗ week ${wid}: direct=${rl} http=${hMap.get(wid)}`); }
    }
    const bySeason = new Map<string, Set<string>>();
    for (const c of direct) { if (!c.seasonKey) continue; const s=bySeason.get(c.seasonKey)??new Set(); s.add(String(c.roleLabel)); bySeason.set(c.seasonKey, s); }
    const resume = await computeSeasonRecords(uid);
    console.log(`\n=== [${name}] direct==HTTP: ${mismatch===0?"✅":"❌ "+mismatch+"건 불일치"} (compared ${compared}, httpCards=${http?.length})`);
    console.log("  시즌별 카드 배지:");
    for (const [sk,set] of [...bySeason].sort()) console.log(`    ${sk}: ${[...set].join(",")}${set.size>1?" ⚠":""}`);
    console.log("  이력서 position:");
    for (const r of resume) console.log(`    ${r.year} ${r.seasonName}: ${r.position}`);
  }
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
