/**
 * cluster4_team_halves.is_qa_test 마이그레이션 적용 (exec_sql RPC).
 *   db/migrations/2026-07-14_cluster4_team_halves_is_qa_test.sql 를 실행(멱등).
 *   exec_sql 부재 시 Supabase SQL Editor 수동 적용 안내만 출력하고 종료(write 0).
 *
 *   npx tsx --env-file=.env.local scripts/apply-team-halves-is-qa-test.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SQL_PATH = "db/migrations/2026-07-14_cluster4_team_halves_is_qa_test.sql";

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
    console.log(`❌ exec_sql 사용 불가(${probe.err}).`);
    console.log(`   → Supabase SQL Editor 에 ${SQL_PATH} 전체를 붙여넣어 실행하세요(멱등).`);
    process.exit(2);
  }
  console.log("exec_sql 사용 가능.");
  const sql = readFileSync(join(process.cwd(), SQL_PATH), "utf8");
  const applied = await execSql(sql);
  console.log("APPLY is_qa_test migration:", applied.ok ? "OK" : `FAIL(${applied.err})`);
  if (!applied.ok) process.exit(1);

  const { error } = await supabaseAdmin.from("cluster4_team_halves").select("is_qa_test").limit(1);
  console.log(`cluster4_team_halves.is_qa_test: ${error ? `ERR(${error.code} ${error.message})` : "OK"}`);
  console.log("✅ 적용 완료.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
