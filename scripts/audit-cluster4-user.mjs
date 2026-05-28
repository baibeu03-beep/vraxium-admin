// Audit Cluster4 line permissions + legacy tables for a single user.
// Usage: node scripts/audit-cluster4-user.mjs
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

const TARGET = "247021bc-374b-48f4-8d49-b181d149ee33";
const TODAY = "2026-05-28";

const out = (label, data) => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(data, null, 2));
};

async function safe(label, fn) {
  try {
    const result = await fn();
    out(label, result);
    return result;
  } catch (e) {
    out(label, { ERROR: String(e?.message ?? e) });
    return null;
  }
}

async function columnsOf(table) {
  // Use PostgREST OPTIONS-like trick: select * limit 0, then inspect via head
  // Easier: query information_schema.columns via rpc not available. Fallback: SELECT * LIMIT 1
  const { data, error } = await sb.from(table).select("*").limit(1);
  if (error) return { ERROR: error.message };
  return { columns: data?.[0] ? Object.keys(data[0]) : [], sampleRow: data?.[0] ?? null };
}

// 1) user_profiles
await safe("1) user_profiles WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("user_profiles")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

// Also try 'id' column in case
await safe("1b) user_profiles WHERE id=TARGET (fallback)", async () => {
  const { data, error, count } = await sb
    .from("user_profiles")
    .select("*", { count: "exact" })
    .eq("id", TARGET);
  return { count, error: error?.message, rows: data };
});

// 2) cluster4_lines counts
await safe("2a) cluster4_lines columns", () => columnsOf("cluster4_lines"));
await safe("2b) cluster4_lines total count", async () => {
  const { count, error } = await sb.from("cluster4_lines").select("*", { count: "exact", head: true });
  return { count, error: error?.message };
});
await safe("2c) cluster4_lines by part_type", async () => {
  const parts = ["info", "competency", "experience", "career"];
  const result = {};
  for (const p of parts) {
    const { count, error } = await sb
      .from("cluster4_lines")
      .select("*", { count: "exact", head: true })
      .eq("part_type", p);
    result[p] = { count, error: error?.message };
  }
  return result;
});
await safe("2d) cluster4_lines 3 most recent", async () => {
  const { data, error } = await sb
    .from("cluster4_lines")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(3);
  return { error: error?.message, rows: data };
});

// 3) cluster4_line_targets WHERE target_user_id=TARGET
await safe("3a) cluster4_line_targets columns", () => columnsOf("cluster4_line_targets"));
await safe("3b) cluster4_line_targets WHERE target_user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("cluster4_line_targets")
    .select("*", { count: "exact" })
    .eq("target_user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

// 3c) JOIN to cluster4_lines via line_id
await safe("3c) cluster4_line_targets joined to cluster4_lines for TARGET", async () => {
  const { data, error } = await sb
    .from("cluster4_line_targets")
    .select("*, cluster4_lines!inner(id, part_type, season_id, week_id, submission_opens_at, submission_closes_at, status)")
    .eq("target_user_id", TARGET);
  return { error: error?.message, rows: data };
});

// 4) cluster4_line_submissions WHERE user_id=TARGET
await safe("4a) cluster4_line_submissions columns", () => columnsOf("cluster4_line_submissions"));
await safe("4b) cluster4_line_submissions WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("cluster4_line_submissions")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

// 5) cluster4_line_targets WHERE target_mode='user' AND target_user_id IS NULL (sanity check)
await safe("5) cluster4_line_targets WHERE target_mode='user' AND target_user_id IS NULL", async () => {
  const { data, error, count } = await sb
    .from("cluster4_line_targets")
    .select("*", { count: "exact" })
    .eq("target_mode", "user")
    .is("target_user_id", null);
  return { count, error: error?.message, rows: data };
});

// 6) Legacy tables
await safe("6a) career_projects columns", () => columnsOf("career_projects"));
await safe("6a2) career_projects WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("career_projects")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

await safe("6b) career_records columns", () => columnsOf("career_records"));
await safe("6b2) career_records WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("career_records")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

await safe("6c) weeklyActivities table", async () => {
  const { data, error } = await sb.from("weeklyActivities").select("*").limit(1);
  return { error: error?.message, sampleRow: data?.[0] };
});
await safe("6c2) weekly_activities table", async () => {
  const { data, error } = await sb.from("weekly_activities").select("*").limit(1);
  return { error: error?.message, sampleRow: data?.[0] };
});

await safe("6d) activity_records columns", () => columnsOf("activity_records"));
await safe("6d2) activity_records WHERE user_id=TARGET (recent 10)", async () => {
  const { data, error, count } = await sb
    .from("activity_records")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET)
    .order("created_at", { ascending: false })
    .limit(10);
  return { count, error: error?.message, rows: data };
});

await safe("6e) user_activity_details columns", () => columnsOf("user_activity_details"));
await safe("6e2) user_activity_details WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("user_activity_details")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

await safe("6f) user_season_histories columns", () => columnsOf("user_season_histories"));
await safe("6f2) user_season_histories WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("user_season_histories")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

await safe("6g) user_edit_windows columns", () => columnsOf("user_edit_windows"));
await safe("6g2) user_edit_windows WHERE user_id=TARGET", async () => {
  const { data, error, count } = await sb
    .from("user_edit_windows")
    .select("*", { count: "exact" })
    .eq("user_id", TARGET);
  return { count, error: error?.message, rows: data };
});

await safe("6h) cluster4_line_permissions (likely DNE)", async () => {
  const { data, error } = await sb.from("cluster4_line_permissions").select("*").limit(1);
  return { error: error?.message, rows: data };
});
await safe("6i) cluster4_line_assignments (likely DNE)", async () => {
  const { data, error } = await sb.from("cluster4_line_assignments").select("*").limit(1);
  return { error: error?.message, rows: data };
});

// 7) Current week
await safe("7a) weeks columns", () => columnsOf("weeks"));
await safe("7b) weeks containing TODAY=2026-05-28", async () => {
  // Try common column names; we'll discover after first call
  const { data, error } = await sb
    .from("weeks")
    .select("*")
    .lte("start_date", TODAY)
    .gte("end_date", TODAY);
  return { error: error?.message, rows: data };
});
await safe("7c) weeks fallback: starts_at/ends_at", async () => {
  const { data, error } = await sb
    .from("weeks")
    .select("*")
    .lte("starts_at", TODAY)
    .gte("ends_at", TODAY);
  return { error: error?.message, rows: data };
});

console.log("\n===== DONE =====");
