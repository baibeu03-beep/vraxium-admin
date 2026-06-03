// Ground-truth count/age probe for cluster4_line_submissions (read-only, no auth).
// Answers the 7 verification items with REAL queries against the live DB.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnv(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(".env.local");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY);
const out = { dbHost: url ? new URL(url).host : "(missing)" };

// which timestamp columns exist
const tsCandidates = ["created_at", "submitted_at", "updated_at"];
out.timestampColumns = {};
for (const c of tsCandidates) {
  const { error } = await db.from("cluster4_line_submissions").select(c).limit(1);
  out.timestampColumns[c] = error ? `MISSING: ${error.message}` : "exists";
}
// pick an ordering column that exists
const orderCol = out.timestampColumns.created_at === "exists"
  ? "created_at"
  : out.timestampColumns.submitted_at === "exists"
    ? "submitted_at"
    : "updated_at";
out.orderColumnUsed = orderCol;

// 1) total row count
{
  const { count, error } = await db
    .from("cluster4_line_submissions")
    .select("id", { count: "exact", head: true });
  out.item1_totalRows = error ? `ERR: ${error.message}` : count;
}

// 2) last 30 days, 3) last 90 days (by orderCol)
const nowMs = Date.parse(new Date().toISOString());
const isoDaysAgo = (d) => new Date(nowMs - d * 86400000).toISOString();
for (const [key, days] of [["item2_last30d", 30], ["item3_last90d", 90]]) {
  const { count, error } = await db
    .from("cluster4_line_submissions")
    .select("id", { count: "exact", head: true })
    .gte(orderCol, isoDaysAgo(days));
  out[key] = error ? `ERR: ${error.message}` : count;
}

// 4) latest row (full)
{
  const { data, error } = await db
    .from("cluster4_line_submissions")
    .select("*")
    .order(orderCol, { ascending: false })
    .limit(1);
  out.item4_latestRow = error ? `ERR: ${error.message}` : (data?.[0] ?? null);
}

// 6) sibling table populations — is data landing elsewhere instead?
for (const t of ["user_activity_details", "career_records", "cluster4_experience_line_drafts"]) {
  const { count, error } = await db.from(t).select("id", { count: "exact", head: true });
  out[`sibling_${t}`] = error ? `ERR/absent: ${error.message}` : count;
}

console.log(JSON.stringify(out, null, 2));
