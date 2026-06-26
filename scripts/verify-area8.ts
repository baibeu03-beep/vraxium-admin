/**
 * area-8 시즌 상태 검증: 시즌별 상태 구간(carded SoT) direct == HTTP.
 *   npx tsx --env-file=.env.local scripts/verify-area8.ts <uid> <seasonKey>
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { computeSeasonActivityStatusesFromCards } from "@/lib/cluster4SeasonCircles";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.BASE_URL || "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;
async function main(){
  const uid = process.argv[2] ?? "16e43a80-094b-48c8-86bc-5f84ea2e0eca"; // 김은서
  const season = process.argv[3] ?? "2025-winter";
  const { data: prof } = await sb.from("user_profiles").select("display_name").eq("user_id",uid).maybeSingle();
  // direct
  const cards = await getCluster4WeeklyCardsForProfileUser(uid);
  const directMap = computeSeasonActivityStatusesFromCards(cards as any);
  // HTTP
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": KEY } });
  const j = await r.json();
  const httpMap = j.seasonActivityStatusesBySeason ?? {};
  const fmt = (segs:any[]) => (segs??[]).map((s:any)=>`${s.statusLabel}`).join(" → ");
  console.log(`[${(prof as any)?.display_name}] season=${season}`);
  console.log("  direct:", fmt(directMap[season]));
  console.log("  HTTP  :", fmt(httpMap[season]));
  const eq = JSON.stringify(directMap[season]) === JSON.stringify(httpMap[season]);
  console.log(`  direct == HTTP : ${eq ? "✅" : "❌"}`);
  console.log("\n  전체 시즌 맵(HTTP):");
  for (const sk of Object.keys(httpMap).sort()) console.log(`    ${sk}: ${fmt(httpMap[sk])}`);
}
main().then(()=>process.exit(0),(e)=>{console.error(e);process.exit(1);});
