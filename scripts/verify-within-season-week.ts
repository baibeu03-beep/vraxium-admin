/**
 * 한 시즌 안 주차별 역할 배지 차이 검증 (W2 vs W7 등).
 *   npx tsx --env-file=.env.local scripts/verify-within-season-week.ts <uid> <seasonKey>
 *   1) DB 원본(user_position_histories) 2) snapshot direct(recompute) 3) HTTP API 비교
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;
async function main() {
  const uid = process.argv[2] ?? "16e43a80-094b-48c8-86bc-5f84ea2e0eca";
  const season = process.argv[3] ?? "2025-winter";
  const { data: prof } = await sb.from("user_profiles").select("display_name,organization_slug").eq("user_id",uid).maybeSingle();
  const { data: mem } = await sb.from("user_memberships").select("membership_level,is_current").eq("user_id",uid);
  const cur=(mem??[]).find((m:any)=>m.is_current)?.membership_level ?? (mem??[])[0]?.membership_level;
  console.log(`[${(prof as any)?.display_name}] ${(prof as any)?.organization_slug} 현재등급=${cur} | season=${season}`);

  console.log("\n=== 1) DB 원본 user_position_histories ===");
  const { data: ph } = await sb.from("user_position_histories")
    .select("week_number,week_start_date,position_code,raw_level,raw_team,raw_part").eq("user_id",uid).eq("season_key",season).order("week_start_date");
  for (const r of (ph??[]) as any[]) console.log(`  W${r.week_number} ${r.week_start_date} code=${r.position_code} (raw: lvl=${r.raw_level} team=${r.raw_team} part=${r.raw_part})`);

  console.log("\n=== 2) snapshot direct (recompute) ===");
  const cards = await recomputeAndStoreWeeklyCardsSnapshot(uid);
  const directBy = new Map<string,any>();
  for (const c of (cards as any[]).filter(c=>c.seasonKey===season)) directBy.set(c.weekId, c);
  for (const c of [...directBy.values()].sort((a,b)=>a.startDate<b.startDate?-1:1)) console.log(`  W${c.weekNumber} ${c.startDate} roleLabel=${c.roleLabel} weekId=${c.weekId}`);

  console.log("\n=== 3) HTTP API ===");
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": KEY } });
  const j = await r.json();
  const httpBy = new Map<string,any>();
  for (const c of (j.data??[]).filter((c:any)=>c.seasonKey===season)) httpBy.set(c.weekId, c);
  let mism=0;
  for (const [wid,dc] of directBy) { const hc=httpBy.get(wid); if(!hc||hc.roleLabel!==dc.roleLabel){mism++; console.log(`  ✗ W${dc.weekNumber} direct=${dc.roleLabel} http=${hc?.roleLabel}`);} }
  console.log(`  direct == HTTP: ${mism===0?"✅":"❌ "+mism}`);
  for (const c of [...httpBy.values()].sort((a,b)=>a.startDate<b.startDate?-1:1)) console.log(`  W${c.weekNumber} ${c.startDate} HTTP roleLabel=${c.roleLabel} weekId=${c.weekId}`);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
