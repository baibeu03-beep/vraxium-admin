/**
 * 2026-07-17_line_registrations_estimated_duration.sql 적용/확인.
 *   npx tsx --env-file=.env.local scripts/apply-line-duration-migration.ts
 *
 * 이 저장소의 마이그레이션 원칙은 "수동 적용"(db/migrations/README.md)이라 자동 러너가 없다.
 * 이 스크립트는 러너가 아니라 (1) 적용 여부 확인 (2) exec_sql RPC 가 있으면 적용 시도
 * (3) 없으면 SQL Editor 에 붙여넣을 SQL 을 출력하는 보조 도구다.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const sb = createClient(
  ensureEnv("NEXT_PUBLIC_SUPABASE_URL"),
  ensureEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

const SQL_PATH = "db/migrations/2026-07-17_line_registrations_estimated_duration.sql";

// 컬럼 존재 확인 — 1행 select 로 42703 여부를 본다(정보스키마 RPC 불필요).
async function columnExists(): Promise<boolean> {
  const { error } = await sb
    .from("line_registrations")
    .select("id,estimated_duration_minutes")
    .limit(1);
  if (!error) return true;
  if (error.code === "42703" || (error.message ?? "").includes("estimated_duration_minutes")) {
    return false;
  }
  throw new Error(`예상치 못한 오류: ${error.code} ${error.message}`);
}

async function main() {
  if (await columnExists()) {
    console.log("✓ estimated_duration_minutes 컬럼이 이미 존재합니다 (마이그레이션 적용됨).");
    return;
  }
  console.log("· 컬럼 없음 — 적용을 시도합니다.");

  const sql = readFileSync(SQL_PATH, "utf8");
  const { error } = await sb.rpc("exec_sql", { sql });
  if (!error) {
    const ok = await columnExists();
    console.log(ok ? "✓ exec_sql RPC 로 적용 완료." : "✗ exec_sql 은 성공했지만 컬럼이 없습니다.");
    if (!ok) process.exit(1);
    return;
  }

  console.log(`· exec_sql RPC 사용 불가 (${error.code ?? ""} ${error.message}).`);
  console.log("\n※ 수동 적용이 필요합니다 — Supabase SQL Editor 에 아래를 붙여넣어 실행하세요.");
  console.log(`   (원본 파일: ${SQL_PATH})\n`);
  console.log("─".repeat(72));
  console.log(sql);
  console.log("─".repeat(72));
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
