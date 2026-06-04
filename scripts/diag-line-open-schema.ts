import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function cols(table: string) {
  const { data, error } = await sb.from(table).select("*").limit(1);
  if (error) { console.log(`${table}: ERROR ${error.message}`); return; }
  console.log(`${table}: ${data && data[0] ? Object.keys(data[0]).join(", ") : "(no rows)"}`);
}

async function main() {
  for (const t of [
    "cluster4_lines",
    "cluster4_line_targets",
    "cluster4_experience_line_masters",
    "cluster4_line_submissions",
  ]) await cols(t);

  // target_mode 분포
  const { data: tm } = await sb.from("cluster4_line_targets").select("target_mode").limit(2000);
  const dist = new Map<string, number>();
  for (const r of (tm ?? []) as any[]) dist.set(r.target_mode, (dist.get(r.target_mode) ?? 0) + 1);
  console.log("\ntarget_mode 분포:", JSON.stringify(Object.fromEntries(dist)));

  // experience 필수 슬롯 마스터
  const { data: masters } = await sb.from("cluster4_experience_line_masters").select("*").order("experience_slot_order");
  console.log("\nexperience_line_masters:");
  for (const m of (masters ?? []) as any[]) console.log(" ", JSON.stringify(m));

  // active experience 라인 (필수 슬롯 라인 현황)
  const { data: lines } = await sb.from("cluster4_lines")
    .select("id, line_code, line_name, part_type, is_active, submission_closes_at, experience_line_master_id, created_at")
    .eq("part_type", "experience").eq("is_active", true).order("created_at", { ascending: false }).limit(20);
  console.log("\nactive experience lines:", (lines ?? []).length);
  for (const l of (lines ?? []) as any[]) console.log(" ", JSON.stringify(l));
}
main();
