/** READ-ONLY: 봄 W13 experience 개설 라인 + org/슬롯 — growth 2 vs cards 1 원인 추적. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  // 최수빈 카드 W13 weekId 추정: W12=...202605210002 패턴 → weeks 테이블에서 spring 13 조회
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date")
    .eq("season_key", "2026-spring")
    .in("week_number", [12, 13]);
  console.log(JSON.stringify(weeks, null, 2));
  for (const w of weeks ?? []) {
    const { data: targets } = await supabaseAdmin
      .from("cluster4_line_targets")
      .select("id,line_id,target_mode,target_user_id,cluster4_lines!inner(id,part_type,is_active,line_code,experience_line_master_id)")
      .eq("week_id", w.id);
    const exp = ((targets ?? []) as any[]).filter(
      (t) => t.cluster4_lines?.part_type === "experience" && t.cluster4_lines?.is_active,
    );
    const lineIds = [...new Set(exp.map((t) => t.line_id))];
    console.log(`\nW${w.week_number} experience targets=${exp.length} distinct lines=${lineIds.length}`);
    for (const t of exp) {
      console.log(`  line=${t.line_id} code=${t.cluster4_lines?.line_code} master=${t.cluster4_lines?.experience_line_master_id} mode=${t.target_mode} user=${t.target_user_id}`);
    }
    // 마스터 슬롯/org
    const masterIds = [...new Set(exp.map((t) => t.cluster4_lines?.experience_line_master_id).filter(Boolean))];
    if (masterIds.length > 0) {
      const { data: masters } = await supabaseAdmin
        .from("cluster4_experience_line_masters")
        .select("id,line_name,experience_slot_order,organization_slug")
        .in("id", masterIds);
      console.log("  masters:", JSON.stringify(masters));
    }
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
