import { readFile } from "node:fs/promises";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const file = "db/migrations/2026-07-16_experience_team_output_assets.sql";
  const sql = await readFile(file, "utf8");
  const probe = await supabaseAdmin.rpc("exec_sql", { query: "select 1" });
  if (probe.error) {
    console.error(`exec_sql unavailable: ${probe.error.message}. Apply ${file} in Supabase SQL Editor.`);
    process.exit(2);
  }
  const result = await supabaseAdmin.rpc("exec_sql", { query: sql });
  if (result.error) throw result.error;
  console.log(`Applied ${file}`);
}

void main();
