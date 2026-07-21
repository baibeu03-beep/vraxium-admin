/**
 * cluster4_team_week_position_overrides 마이그레이션 적용(exec_sql RPC). 멱등.
 *   db/migrations/2026-07-21_cluster4_team_week_position_overrides.sql 실행.
 *   exec_sql 부재 시 수동 적용 안내만 출력하고 종료(write 0).
 *   Usage: npx tsx --env-file=.env.local scripts/apply-team-week-position-overrides.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SQL_PATH = "db/migrations/2026-07-21_cluster4_team_week_position_overrides.sql";

async function main() {
  // exec_sql 가용성 프로브.
  const probe: { err?: string } = await supabaseAdmin
    .rpc("exec_sql", { query: "select 1;" })
    .then((r: { error?: { message?: string } | null }) => ({ err: r.error?.message }))
    .catch((e: unknown) => ({ err: e instanceof Error ? e.message : String(e) }));
  if (probe.err) {
    console.log(`❌ exec_sql 사용 불가(${probe.err}). Supabase SQL Editor 에서 ${SQL_PATH} 수동 실행하세요.`);
    process.exit(1);
  }
  console.log("exec_sql 사용 가능.");
  const sql = readFileSync(join(process.cwd(), SQL_PATH), "utf8");
  const { error } = await supabaseAdmin.rpc("exec_sql", { query: sql });
  if (error) {
    console.error("❌ 적용 실패:", error.message);
    process.exit(1);
  }
  // 검증 — 테이블/제약 존재.
  const { data, error: qErr } = await supabaseAdmin
    .from("cluster4_team_week_position_overrides")
    .select("id")
    .limit(1);
  if (qErr) {
    console.error("❌ 적용 후 조회 실패:", qErr.message);
    process.exit(1);
  }
  console.log(`✅ 적용 완료. 테이블 조회 OK(rows=${(data ?? []).length}).`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
