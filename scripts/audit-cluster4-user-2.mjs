// Supplemental audit to fill gaps from pass 1.
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
const NOW = new Date().toISOString();
const LINE_IDS = ["cc802135-0ac5-47e0-b093-9e6a4ebe14b1", "5742015a-94ab-4a30-aa62-3c128f83b8aa"];
const LINE_TARGET_IDS = ["351edf6e-212b-4748-8f2f-3b48ec3fee6d", "88b05724-11d9-46b9-94cb-302a1255fb84"];
const WEEK_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // current week

const out = (label, data) => {
  console.log(`\n===== ${label} =====`);
  console.log(JSON.stringify(data, null, 2));
};

// A) Confirm cluster4_line_submissions table exists & introspect via insert-dry / select all (no user filter)
{
  const { count, error } = await sb.from("cluster4_line_submissions").select("*", { count: "exact", head: true });
  out("A1) cluster4_line_submissions TOTAL count (all users)", { count, error: error?.message });
}
{
  const { data, error } = await sb.from("cluster4_line_submissions").select("*").limit(3);
  out("A2) cluster4_line_submissions sample 3 rows (all users)", {
    error: error?.message,
    columns: data?.[0] ? Object.keys(data[0]) : "(table empty - cannot infer columns from SELECT)",
    rows: data,
  });
}

// B) Re-do JOIN without non-existent columns
{
  const { data, error } = await sb
    .from("cluster4_line_targets")
    .select("*, cluster4_lines!inner(id, part_type, main_title, submission_opens_at, submission_closes_at, is_active, line_code)")
    .eq("target_user_id", TARGET);
  out("B) line_targets JOIN lines for TARGET", { error: error?.message, rows: data });
}

// C) Window open right now? Check each line
{
  const { data, error } = await sb
    .from("cluster4_lines")
    .select("id, part_type, main_title, submission_opens_at, submission_closes_at, is_active, line_code")
    .in("id", LINE_IDS);
  const enriched = data?.map((r) => ({
    ...r,
    window_open_now:
      r.is_active &&
      new Date(r.submission_opens_at) <= new Date(NOW) &&
      new Date(NOW) <= new Date(r.submission_closes_at),
    now: NOW,
  }));
  out("C) Are line submission windows OPEN at server-now?", { error: error?.message, NOW, rows: enriched });
}

// D) Per line_target_id, check if a submission row exists
{
  const result = [];
  for (const tid of LINE_TARGET_IDS) {
    const { data, error, count } = await sb
      .from("cluster4_line_submissions")
      .select("*", { count: "exact" })
      .eq("line_target_id", tid)
      .eq("user_id", TARGET);
    result.push({ line_target_id: tid, count, error: error?.message, rows: data });
  }
  out("D) submissions per (line_target_id, TARGET)", result);
}

// E) Sanity: cluster4 work_* edit_windows currently open?
{
  const { data, error } = await sb
    .from("user_edit_windows")
    .select("*")
    .eq("user_id", TARGET)
    .in("resource_key", ["cluster4.work_exp", "cluster4.work_info", "cluster4.work_career", "cluster4.work_ability"]);
  const enriched = data?.map((r) => ({
    resource_key: r.resource_key,
    opened_at: r.opened_at,
    expires_at: r.expires_at,
    window_open_now: new Date(r.opened_at) <= new Date(NOW) && new Date(NOW) <= new Date(r.expires_at),
  }));
  out("E) cluster4 work_* edit_windows open now?", { NOW, error: error?.message, rows: enriched });
}

// F) Also try alternative column for career_projects (maybe owner_id, profile_id, ...)
{
  const { data, error } = await sb.from("career_projects").select("*").limit(1);
  out("F1) career_projects sample row (to see columns)", { error: error?.message, columns: data?.[0] ? Object.keys(data[0]) : "(empty)", row: data?.[0] });
}
{
  // try all distinct rows count
  const { count, error } = await sb.from("career_projects").select("*", { count: "exact", head: true });
  out("F2) career_projects TOTAL count", { count, error: error?.message });
}

// G) career_records sample to confirm columns
{
  const { data, error } = await sb.from("career_records").select("*").limit(1);
  out("G) career_records sample row", { error: error?.message, columns: data?.[0] ? Object.keys(data[0]) : "(empty)", row: data?.[0] });
}
{
  const { count, error } = await sb.from("career_records").select("*", { count: "exact", head: true });
  out("G2) career_records TOTAL count", { count, error: error?.message });
}

console.log("\n===== DONE =====");
