/**
 * 긴급 휴식 마이그레이션 적용 (exec_sql RPC).
 *   db/migrations/2026-07-12_emergency_rest.sql 를 그대로 실행(Idempotent).
 *   exec_sql 부재 시 Supabase SQL Editor 수동 적용 안내.
 *
 *   npx tsx --env-file=.env.local scripts/apply-emergency-rest.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function execSql(query: string): Promise<{ ok: boolean; err?: string }> {
  try {
    const r: { error?: { message?: string } | null } = await supabaseAdmin.rpc("exec_sql", { query });
    if (r?.error) return { ok: false, err: r.error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const probe = await execSql("SELECT 1;");
  if (!probe.ok) {
    console.log(
      `❌ exec_sql 사용 불가(${probe.err}). Supabase SQL Editor 에 db/migrations/2026-07-12_emergency_rest.sql 수동 적용 요망.`,
    );
    process.exit(2);
  }
  console.log("exec_sql 사용 가능.");

  const sqlPath = join(process.cwd(), "db/migrations/2026-07-12_emergency_rest.sql");
  const sql = readFileSync(sqlPath, "utf8");
  const applied = await execSql(sql);
  console.log("APPLY emergency-rest migration:", applied.ok ? "OK" : `FAIL(${applied.err})`);
  if (!applied.ok) process.exit(1);

  // 컬럼 존재 확인(select 성공 여부).
  for (const [table, col] of [
    ["vacation_requests", "requested_by_user_id"],
    ["vacation_requests", "week_id"],
    ["vacation_requests", "po_c_act_id"],
    ["process_irregular_acts", "origin"],
  ] as const) {
    const { error } = await supabaseAdmin.from(table).select(col).limit(1);
    console.log(`  ${table}.${col}: ${error ? `ERR(${error.code} ${error.message})` : "OK"}`);
  }
  console.log("✅ 긴급 휴식 컬럼 적용 완료.");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
