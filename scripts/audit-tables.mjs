// One-off: row counts + view/base-table classification for table-role audit.
// Usage: node scripts/audit-tables.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(url, key, { auth: { persistSession: false } });

const tables = [
  "crew_list_view", "admin_crew_list_view", "legacy_crew_import",
  "season_reputations", "season_reputation_scores",
  "weekly_reputations", "weekly_reputation_scores",
  "user_profiles", "user_introductions", "user_cluster2",
  "career_records", "career_projects", "career_project_weeks",
  "user_cumulative_points", "user_growth_stats",
];

const results = [];
for (const t of tables) {
  try {
    const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
    results.push({ table: t, count: count ?? null, error: error?.message ?? null });
  } catch (e) {
    results.push({ table: t, count: null, error: String(e?.message ?? e) });
  }
}

// View vs base table via information_schema (requires RPC or use raw via supabase-js? not supported, so try a known signal)
// Heuristic fallback: postgrest exposes views read-only; an insert with empty body would error.
// We'll just print results; view/base detection done via migration file inspection later.

console.log(JSON.stringify({ url, results }, null, 2));
