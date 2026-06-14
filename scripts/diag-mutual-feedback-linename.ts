/**
 * diag-mutual-feedback-linename.ts  (READ-ONLY — write 0)
 * "[생산성] 상호 피드백" 라인명 정정 조사.
 * 실행: npx tsx --env-file=.env.local scripts/diag-mutual-feedback-linename.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log("=== 1) line_registrations (experience hub, 피드백/상호/EN0004 후보) ===");
  const { data: regs, error: regErr } = await sb
    .from("line_registrations")
    .select("id,line_code,line_name,line_type,main_title,main_title_mode,organization_slug,is_active,bridged_master_id,hub")
    .eq("hub", "experience")
    .order("organization_slug", { ascending: true })
    .order("line_code", { ascending: true });
  if (regErr) { console.error(regErr); return; }
  const feedback = (regs ?? []).filter((r: any) =>
    (r.line_name ?? "").includes("피드백") || (r.line_name ?? "").includes("상호") ||
    (r.line_code ?? "").endsWith("EN0004") || (r.line_code ?? "").endsWith("EN0001"));
  for (const r of feedback as any[]) {
    console.log(`  org=${String(r.organization_slug ?? "NULL").padEnd(8)} code=${String(r.line_code).padEnd(14)} type=${r.line_type} active=${r.is_active} mode=${r.main_title_mode}`);
    console.log(`     line_name = "${r.line_name}"`);
    console.log(`     main_title= "${r.main_title}"   bridged=${r.bridged_master_id}`);
  }

  console.log("\n=== 2) cluster4_experience_line_masters (fallback table, 피드백 후보) ===");
  const { data: masters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,line_name,experience_category,experience_slot_order,organization_slug")
    .or("line_name.ilike.%피드백%,line_name.ilike.%상호%");
  for (const m of (masters ?? []) as any[]) {
    console.log(`  id=${m.id} org=${m.organization_slug ?? "NULL"} cat=${m.experience_category} slot=${m.experience_slot_order} line_name="${m.line_name}"`);
  }

  console.log("\n=== 3) 이미 개설된 cluster4_lines (해당 master/ code 참조) ===");
  const bridgedIds = (feedback as any[]).map((r) => r.bridged_master_id).filter(Boolean);
  const codes = Array.from(new Set((feedback as any[]).map((r) => r.line_code)));
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,line_code,main_title,experience_line_master_id,team_id,is_active,created_at")
    .eq("part_type", "experience")
    .or(`line_code.in.(${codes.join(",")}),experience_line_master_id.in.(${bridgedIds.length ? bridgedIds.join(",") : "00000000-0000-0000-0000-000000000000"})`)
    .order("created_at", { ascending: false });
  console.log(`  개설된 experience 라인(매칭 code/master) = ${(lines ?? []).length}건`);
  for (const l of (lines ?? []) as any[]) {
    console.log(`  code=${String(l.line_code).padEnd(14)} active=${l.is_active} master=${(l.experience_line_master_id ?? "null").slice(0,8)} main_title="${l.main_title}" team=${(l.team_id??"-").slice(0,8)} ${l.created_at}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
