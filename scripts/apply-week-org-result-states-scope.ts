// 2026-07-19_week_org_result_states_scope.sql 적용/확인.
//   exec_sql RPC 가 있으면 적용, 없으면 SQL Editor 안내. 적용 후 scope 컬럼/PK 존재 확인.
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const SQL_PATH = "db/migrations/2026-07-19_week_org_result_states_scope.sql";

async function columnExists(): Promise<boolean> {
  // scope 컬럼이 있으면 select 성공.
  const { error } = await supabaseAdmin
    .from("cluster4_week_org_result_states")
    .select("scope", { head: true, count: "exact" });
  return !error;
}

async function main() {
  if (await columnExists()) {
    console.log("✓ scope 컬럼 이미 존재 — 적용됨(idempotent).");
    return;
  }
  const sql = readFileSync(SQL_PATH, "utf8");
  const { error } = await supabaseAdmin.rpc("exec_sql", { sql });
  if (error) {
    console.log(`✗ exec_sql RPC 사용 불가 (${error.code ?? ""} ${error.message}).`);
    console.log("→ Supabase SQL Editor 에서 아래 파일을 수동 실행해주세요:");
    console.log(`   ${SQL_PATH}`);
    process.exit(2);
  }
  if (await columnExists()) console.log("✓ exec_sql RPC 로 scope 컬럼/PK 적용 완료.");
  else { console.log("✗ exec_sql 성공했지만 scope 컬럼이 없습니다."); process.exit(1); }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
