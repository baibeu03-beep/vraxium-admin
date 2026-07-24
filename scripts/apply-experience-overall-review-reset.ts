// 2026-07-23_experience_overall_review_reset.sql 적용(멱등).
//   실행: npx tsx --env-file=.env.local scripts/apply-experience-overall-review-reset.ts
//   exec_sql RPC 가 없으면 Supabase SQL Editor 수동 적용 안내 후 종료(코드 2).
import { readFile } from "node:fs/promises";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const file = "db/migrations/2026-07-23_experience_overall_review_reset.sql";
  const sql = await readFile(file, "utf8");
  const probe = await supabaseAdmin.rpc("exec_sql", { query: "select 1" });
  if (probe.error) {
    console.error(
      `exec_sql unavailable: ${probe.error.message}. Apply ${file} in Supabase SQL Editor.`,
    );
    process.exit(2);
  }
  const result = await supabaseAdmin.rpc("exec_sql", { query: sql });
  if (result.error) throw result.error;
  console.log(`Applied ${file}`);
}

void main();
