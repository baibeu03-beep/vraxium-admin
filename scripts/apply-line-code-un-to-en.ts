/**
 * [통합] line_code 접두어 정정 EXBS-UN → EXBS-EN (2026-06-07 승인).
 *
 *   npx tsx --env-file=.env.local scripts/apply-line-code-un-to-en.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-line-code-un-to-en.ts --apply
 *
 * 범위: cluster4_lines(31) · cluster4_experience_line_masters(EXBS-UN0000) ·
 *   line_registrations(sync 복제본). line_code 문자열만 — week_id/target/snapshot 구조/
 *   DTO/판정 무변경. 행 단위 prior 를 run log 에 기록 (rollback = EN→UN 역치환).
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");
const OUT = `claudedocs/line-code-un-to-en-${APPLY ? "apply" : "dryrun"}-20260607.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

const TABLES = ["cluster4_lines", "cluster4_experience_line_masters", "line_registrations"] as const;

async function main() {
  const plan: Array<{ table: string; id: string; prior: string; next: string }> = [];
  for (const t of TABLES) {
    const { data, error } = await sb.from(t).select("id,line_code").like("line_code", "EXBS-UN%").order("id").range(0, 999);
    if (error) throw new Error(`${t}: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string; line_code: string }>) {
      plan.push({ table: t, id: r.id, prior: r.line_code, next: r.line_code.replace("EXBS-UN", "EXBS-EN") });
    }
  }
  console.log(`rename 대상: ${plan.length}행 (${TABLES.map((t) => t + " " + plan.filter((p) => p.table === t).length).join(" · ")})`);

  const applied: Array<{ table: string; id: string; prior: string; next: string }> = [];
  const errors: string[] = [];
  if (APPLY) {
    for (const p of plan) {
      const { data, error } = await sb.from(p.table)
        .update({ line_code: p.next, updated_at: new Date().toISOString() })
        .eq("id", p.id)
        .eq("line_code", p.prior) // 구값 가드
        .select("id");
      if (error || (data ?? []).length !== 1) errors.push(`${p.table} ${p.id}: ${error?.message ?? "rows≠1"}`);
      else applied.push(p);
    }
  }
  // 검증: 잔존/신규 카운트
  const counts: Record<string, { un: number; en: number }> = {};
  for (const t of TABLES) {
    const { count: un } = await sb.from(t).select("id", { count: "exact", head: true }).like("line_code", "EXBS-UN%");
    const { count: en } = await sb.from(t).select("id", { count: "exact", head: true }).like("line_code", "EXBS-EN%");
    counts[t] = { un: un ?? 0, en: en ?? 0 };
  }
  const report = { mode: APPLY ? "apply" : "dry-run", planned: plan.length, applied: applied.length, errors, counts, plan };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ mode: report.mode, planned: report.planned, applied: report.applied, errors, counts }, null, 2));
  console.log("→", OUT);
  if (errors.length) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
