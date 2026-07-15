/**
 * READ-ONLY 조사 v2: 허브별 line_registrations 코드 ↔ 실제 오픈 라인 SoT 조인 키.
 *   npx tsx --env-file=.env.local scripts/inspect-line-join-v2.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const { data: lr } = await supabaseAdmin
    .from("line_registrations")
    .select("id, hub, line_type, line_code, organization_slug, is_active, line_name");
  const rows = (lr ?? []) as any[];

  // 1) info 9행 전량.
  console.log("=== line_registrations hub=info (9) ===");
  for (const r of rows.filter((r) => r.hub === "info"))
    console.log(`  org=${r.organization_slug} type=${r.line_type} code=${r.line_code} name=${r.line_name}`);

  // 2) experience: org × line_type.
  console.log("\n=== hub=experience: (org, line_type) 분포 ===");
  const expMap = new Map<string, number>();
  for (const r of rows.filter((r) => r.hub === "experience")) {
    const k = `${r.organization_slug} | ${r.line_type}`;
    expMap.set(k, (expMap.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...expMap.entries()].sort()) console.log(`  ${k}: ${v}`);
  console.log("experience line_type 집합:", [...new Set(rows.filter((r) => r.hub === "experience").map((r) => r.line_type))]);

  // 3) competency: org × line_type + 코드.
  console.log("\n=== hub=competency: (org, line_type) 분포 ===");
  const cpMap = new Map<string, number>();
  for (const r of rows.filter((r) => r.hub === "competency")) {
    const k = `${r.organization_slug} | ${r.line_type}`;
    cpMap.set(k, (cpMap.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...cpMap.entries()].sort()) console.log(`  ${k}: ${v}`);
  console.log("competency line_code 샘플:", rows.filter((r) => r.hub === "competency").slice(0, 12).map((r) => r.line_code));

  // 4) activity_types 전량(info 매핑 확인).
  const { data: at } = await supabaseAdmin.from("activity_types").select("id, name, line_code, is_active");
  console.log("\n=== activity_types 전량 ===");
  for (const r of (at ?? []) as any[]) console.log(`  id=${r.id} code=${r.line_code} name=${r.name} active=${r.is_active}`);

  // 5) opened_lines category distinct + line_id 대상 확인.
  const { data: eol } = await supabaseAdmin.from("cluster4_experience_team_overall_opened_lines").select("category, line_id").limit(200);
  const eolRows = (eol ?? []) as any[];
  console.log("\n=== experience opened_lines: category distinct ===");
  console.log("  categories:", [...new Set(eolRows.map((r) => r.category))]);
  console.log("  line_id null 비율:", eolRows.filter((r) => r.line_id == null).length, "/", eolRows.length);

  // 6) competency cluster4_lines.line_code ↔ line_registrations(competency) 매칭.
  const { data: clc } = await supabaseAdmin.from("cluster4_lines").select("line_code, part_type, competency_line_master_id").eq("part_type", "competency").limit(200);
  const clcRows = (clc ?? []) as any[];
  const lrCompCodes = new Set(rows.filter((r) => r.hub === "competency").map((r) => r.line_code));
  const clCompCodes = [...new Set(clcRows.map((r) => r.line_code))];
  const matched = clCompCodes.filter((c) => lrCompCodes.has(c));
  console.log("\n=== competency cluster4_lines.line_code ↔ line_registrations 매칭 ===");
  console.log(`  cluster4_lines(competency) 코드 ${clCompCodes.length}종, line_registrations(competency) 코드 ${lrCompCodes.size}종, 교집합 ${matched.length}`);
  console.log("  cluster4_lines 코드 샘플:", clCompCodes.slice(0, 10));
  console.log("  competency_line_master_id 존재 비율:", clcRows.filter((r) => r.competency_line_master_id != null).length, "/", clcRows.length);

  // 7) master 테이블 존재 여부.
  for (const t of ["cluster4_competency_line_masters", "cluster4_experience_line_masters", "competency_line_masters", "experience_line_masters"]) {
    const { error } = await supabaseAdmin.from(t).select("*").limit(1);
    console.log(`  테이블 ${t}: ${error ? "없음/" + (error.code ?? error.message) : "존재"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
