/**
 * READ-ONLY 조사: line_registrations ↔ 주차별 오픈 라인 조인 가능성(실데이터).
 *   운영 DB 미변경(SELECT 만). npx tsx --env-file=.env.local scripts/inspect-line-join-data.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function keys(rows: unknown[]): string {
  return rows[0] ? Object.keys(rows[0] as Record<string, unknown>).join(", ") : "(행 없음)";
}
async function dump(table: string, limit = 3) {
  const { data, error } = await supabaseAdmin.from(table).select("*").limit(limit);
  if (error) { console.log(`\n### ${table}: ERROR ${error.code ?? ""} ${error.message}`); return null; }
  const rows = data ?? [];
  console.log(`\n### ${table} — 컬럼: ${keys(rows)}`);
  return rows;
}

async function main() {
  // 1) line_registrations 전량 — hub/line_type/line_code/org/active 분포 + 중복.
  const { data: lr, error: lrErr } = await supabaseAdmin
    .from("line_registrations")
    .select("id, hub, line_type, line_code, organization_slug, is_active, line_name");
  if (lrErr) { console.log("line_registrations ERROR:", lrErr.message); }
  const rows = (lr ?? []) as any[];
  console.log(`\n=== line_registrations 총 ${rows.length}행 ===`);
  console.log("컬럼:", keys(rows));
  const byHub = new Map<string, number>();
  const byOrg = new Map<string, number>();
  let nullCode = 0, inactive = 0;
  for (const r of rows) {
    byHub.set(r.hub, (byHub.get(r.hub) ?? 0) + 1);
    byOrg.set(r.organization_slug ?? "<null>", (byOrg.get(r.organization_slug ?? "<null>") ?? 0) + 1);
    if (r.line_code == null || r.line_code === "") nullCode++;
    if (!r.is_active) inactive++;
  }
  console.log("hub 분포:", Object.fromEntries(byHub));
  console.log("org 분포:", Object.fromEntries(byOrg));
  console.log(`line_code null/빈: ${nullCode} · 비활성: ${inactive}`);

  // line_code 유일성(전역 / org+hub 스코프).
  const codeGlobal = new Map<string, number>();
  const codeScoped = new Map<string, number>();
  const htcScoped = new Map<string, number>(); // org+hub+line_type+line_code
  for (const r of rows) {
    if (r.line_code) {
      codeGlobal.set(r.line_code, (codeGlobal.get(r.line_code) ?? 0) + 1);
      const sk = `${r.organization_slug}|${r.hub}|${r.line_code}`;
      codeScoped.set(sk, (codeScoped.get(sk) ?? 0) + 1);
      const hk = `${r.organization_slug}|${r.hub}|${r.line_type}|${r.line_code}`;
      htcScoped.set(hk, (htcScoped.get(hk) ?? 0) + 1);
    }
  }
  const dupG = [...codeGlobal.entries()].filter(([, v]) => v > 1);
  const dupS = [...codeScoped.entries()].filter(([, v]) => v > 1);
  const dupH = [...htcScoped.entries()].filter(([, v]) => v > 1);
  console.log(`line_code 전역 중복 그룹: ${dupG.length}`, dupG.slice(0, 5));
  console.log(`(org+hub+line_code) 중복 그룹: ${dupS.length}`, dupS.slice(0, 5));
  console.log(`(org+hub+line_type+line_code) 중복 그룹: ${dupH.length}`, dupH.slice(0, 5));
  console.log("line_type 샘플:", [...new Set(rows.map((r) => r.line_type))].slice(0, 20));
  console.log("line_code 샘플:", rows.slice(0, 10).map((r) => `${r.hub}/${r.line_type}/${r.line_code}`));

  // 2) 주차별 오픈/마스터 SoT 후보 테이블 컬럼 탐색.
  const at = await dump("activity_types");
  if (at) console.log("activity_types 샘플:", (at as any[]).map((r) => ({ id: r.id, category: r.category, name: r.name, code: r.code ?? r.line_code })));
  const cl = await dump("cluster4_lines");
  if (cl) console.log("cluster4_lines 샘플:", (cl as any[]).map((r) => ({ id: r.id, part_type: r.part_type, activity_type_id: r.activity_type_id, line_code: r.line_code, line_registration_id: r.line_registration_id })));
  await dump("cluster4_experience_team_overall");
  const eol = await dump("cluster4_experience_team_overall_opened_lines");
  if (eol) console.log("opened_lines 샘플:", (eol as any[]).map((r) => ({ category: r.category, line_id: r.line_id, team_id: r.team_id })));

  // 3) info: activity_types(practical_info) 목록 vs line_registrations(hub=info) 매핑 시도(line_code 기준).
  const { data: atInfo } = await supabaseAdmin.from("activity_types").select("*").limit(50);
  const atRows = (atInfo ?? []) as any[];
  const infoAt = atRows.filter((r) => (r.category ?? r.hub) === "practical_info" || (r.category ?? "").includes("info"));
  console.log(`\nactivity_types(practical_info 추정) ${infoAt.length}행:`, infoAt.map((r) => ({ id: r.id, name: r.name, code: r.code ?? r.line_code ?? "(코드컬럼없음)" })));
  const lrInfoCodes = new Set(rows.filter((r) => r.hub === "info" && r.line_code).map((r) => r.line_code));
  console.log("line_registrations(hub=info) line_code 집합:", [...lrInfoCodes]);
}
main().catch((e) => { console.error(e); process.exit(1); });
