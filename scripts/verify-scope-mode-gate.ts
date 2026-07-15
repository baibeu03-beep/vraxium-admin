import { supabaseAdmin } from "@/lib/supabaseAdmin";
async function main(){
  const w = "39aae7a0-216f-4262-8a67-6beef1bccf22";
  for (const effMode of ["operating","test"] as const) {
    const { count: irrPend } = await supabaseAdmin.from("process_irregular_acts")
      .select("id",{count:"exact",head:true}).eq("week_id",w).eq("kind","review_request").eq("status","pending").eq("scope_mode",effMode);
    const { count: regPend } = await supabaseAdmin.from("process_check_statuses")
      .select("id",{count:"exact",head:true}).eq("week_id",w).eq("status","pending").eq("scope_mode",effMode);
    const { count: awards } = await supabaseAdmin.from("process_point_awards")
      .select("id",{count:"exact",head:true}).eq("year",2026).eq("week_number",28).eq("scope_mode",effMode);
    console.log(`effMode=${effMode}: 정규 pending=${regPend} · 변동 pending=${irrPend} · awards=${awards}`);
  }
  console.log("\n▶ 프로덕션(operating) 검수라면 operating 변동 pending=1 → 정상 차단 유지");
  console.log("▶ 현 QA env(test 코호트) 검수라면 test pending=0 → 미완료 0건(정확)");
}
main().catch(e=>{console.error(e);process.exit(1);});
