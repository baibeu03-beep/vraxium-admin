import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main() {
  const w = "39aae7a0-216f-4262-8a67-6beef1bccf22";
  // 정확한 count (head:true — cap 무관).
  const { count: allC } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("week_id", w);
  const { count: expC } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("week_id", w).eq("part_type","experience");
  const { count: infoC } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("week_id", w).eq("part_type","info");
  console.log(`week28(${w}) cluster4_lines: 전체=${allC} · experience=${expC} · info=${infoC}`);
  // experience 라인이 있는 최근 주차들(정확 count).
  const { data: ws } = await supabaseAdmin.from("weeks").select("id,start_date,iso_week,season_key").eq("season_key","2026-summer").order("start_date");
  console.log(`\n2026-summer 주차별 experience 라인 수(정확):`);
  for (const wk of (ws ?? []) as any[]) {
    const { count } = await supabaseAdmin.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("week_id", wk.id).eq("part_type","experience");
    console.log(`  ${wk.start_date} (w${wk.iso_week}) ${wk.id===w?"← 검수대상":""}: experience=${count}`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
