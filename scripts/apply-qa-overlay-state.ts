/**
 * QA 오버레이 상태 마이그레이션 적용 (exec_sql RPC).
 *   db/migrations/2026-06-30_qa_overlay_state.sql 를 그대로 실행 — qa_weeks_state /
 *   qa_org_week_thresholds / qa_action_log 생성(Idempotent). exec_sql 부재 시 수동 안내.
 *
 *   npx tsx --env-file=.env.local scripts/apply-qa-overlay-state.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function execSql(query: string): Promise<{ ok: boolean; err?: string }> {
  try {
    const r: any = await supabaseAdmin.rpc("exec_sql", { query });
    if (r?.error) return { ok: false, err: r.error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

async function tableCount(table: string): Promise<number | string> {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) return `ERR(${error.message})`;
  return count ?? 0;
}

async function main() {
  const probe = await execSql("SELECT 1;");
  if (!probe.ok) {
    console.log(
      `❌ exec_sql 사용 불가(${probe.err}). Supabase SQL Editor 에 db/migrations/2026-06-30_qa_overlay_state.sql 수동 적용 요망.`,
    );
    process.exit(2);
  }
  console.log("exec_sql 사용 가능.");

  const sqlPath = join(
    process.cwd(),
    "db/migrations/2026-06-30_qa_overlay_state.sql",
  );
  const sql = readFileSync(sqlPath, "utf8");
  const applied = await execSql(sql);
  console.log("APPLY qa overlay migration:", applied.ok ? "OK" : `FAIL(${applied.err})`);
  if (!applied.ok) process.exit(1);

  for (const t of ["qa_weeks_state", "qa_org_week_thresholds", "qa_action_log"]) {
    console.log(`  ${t}: rows=${await tableCount(t)}`);
  }
  console.log("✅ qa_* 오버레이 테이블 적용 완료.");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
