/**
 * READ-ONLY 조사: process_acts.act_type 분포/누락/스코프 패턴.
 *   운영 DB 미변경(SELECT 만). npx tsx --env-file=.env.local scripts/inspect-process-acts-acttype.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("process_acts")
    .select("id, hub, act_type, is_active, check_target, point_check, point_advantage, point_penalty, line_group_id");
  if (error) { console.error("query error:", error.message); process.exit(1); }
  const rows = data ?? [];
  console.log(`총 process_acts 행: ${rows.length}`);

  // 1) act_type 분포(null 포함).
  const byType = new Map<string, number>();
  for (const r of rows) {
    const k = (r as any).act_type ?? "<NULL>";
    byType.set(k, (byType.get(k) ?? 0) + 1);
  }
  console.log("\n[1] act_type 분포:");
  for (const [k, v] of [...byType.entries()].sort()) console.log(`  ${k}: ${v}`);

  // 2) null/빈 act_type 행 상세.
  const nulls = rows.filter((r) => (r as any).act_type == null || (r as any).act_type === "");
  console.log(`\n[2] act_type null/빈값 행: ${nulls.length}`);
  for (const r of nulls.slice(0, 20)) console.log(`  id=${(r as any).id} hub=${(r as any).hub} is_active=${(r as any).is_active}`);

  // 3) hub × act_type 교차(활성만).
  const active = rows.filter((r) => (r as any).is_active);
  console.log(`\n[3] 활성 행 ${active.length} — hub × act_type:`);
  const cross = new Map<string, number>();
  for (const r of active) {
    const k = `${(r as any).hub} / ${(r as any).act_type ?? "<NULL>"}`;
    cross.set(k, (cross.get(k) ?? 0) + 1);
  }
  for (const [k, v] of [...cross.entries()].sort()) console.log(`  ${k}: ${v}`);

  // 4) 예상외 enum 값(required|optional|selection|basic 이외).
  const KNOWN = new Set(["required", "optional", "selection", "basic"]);
  const unexpected = [...byType.keys()].filter((k) => k !== "<NULL>" && !KNOWN.has(k));
  console.log(`\n[4] 예상외 enum 값: ${unexpected.length ? unexpected.join(", ") : "없음"}`);

  // 5) required 액트의 포인트 존재 여부(A/B 가 0 인 required 행 수).
  const req = active.filter((r) => (r as any).act_type === "required");
  const reqZeroAB = req.filter((r) => ((r as any).point_check ?? 0) === 0 && ((r as any).point_advantage ?? 0) === 0);
  console.log(`\n[5] 활성 required 액트: ${req.length} (그중 A=B=0 인 행: ${reqZeroAB.length})`);

  // 6) process_acts 에 org/scope 컬럼이 있는지 간접 확인.
  console.log(`\n[6] 반환 컬럼 keys 샘플: ${rows[0] ? Object.keys(rows[0] as any).join(", ") : "(행 없음)"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
