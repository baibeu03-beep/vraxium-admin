import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const key = process.env.INTERNAL_API_KEY!;
  const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
  const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  const ids = (data??[]).map((r:any)=>r.user_id);
  const targets = ["247021bc","369d11e5","e1a17a4a"].map(p=>ids.find((id:string)=>id.startsWith(p))!).filter(Boolean);
  for (const uid of targets) {
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": key },
    });
    const json:any = await res.json();
    const card = (json.data ?? []).find((c:any)=>c.weekId===W13);
    const byPart:any = {};
    for (const l of (card?.lines ?? [])) if(!byPart[l.partType]) byPart[l.partType]={n:l.numerator,d:l.denominator,r:l.rate,cnt:0}, byPart[l.partType].cnt=0;
    for (const l of (card?.lines ?? [])) byPart[l.partType].cnt++;
    console.log(`\nuser=${uid.slice(0,8)} http=${res.status} success=${json.success} cards=${json.data?.length}`);
    if (card) {
      console.log(`  [HTTP] W13 주차성장률=${card.weeklyGrowthRate}% (${card.growthNumerator}/${card.growthDenominator})`);
      for (const p of ["information","experience","competency","career"]) {
        const b=byPart[p]; if(b) console.log(`    ${p}: 칸${b.cnt} ${b.n}/${b.d} (${b.r}%)`);
      }
    } else console.log("  W13 카드 없음");
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
