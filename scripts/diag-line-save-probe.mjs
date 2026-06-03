// One-off ground-truth probe for the 4-hub line-save bug.
// Reads .env.local, then inspects the LIVE cluster4_line_submissions store:
//   1) which DB are we hitting (host only)
//   2) does a recent submission row exist? (are writes landing at all)
//   3) what columns does a row actually have (growth_point/output_links/output_images present?)
//   4) currently-open lines + their user targets (so a real save can be reproduced)
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// minimal .env.local loader (no dotenv dependency assumption)
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
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log("DB host:", url ? new URL(url).host : "(missing)");
const db = createClient(url, key);

const out = {};

// 1) recent submissions — are ANY writes landing, and when was the latest?
{
  const { data, error } = await db
    .from("cluster4_line_submissions")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(5);
  out.recentSubmissions = {
    error: error?.message ?? null,
    count: data?.length ?? 0,
    latestUpdatedAt: data?.[0]?.updated_at ?? null,
    sampleColumns: data?.[0] ? Object.keys(data[0]).sort() : null,
    rows: (data ?? []).map((r) => ({
      line_target_id: r.line_target_id,
      user_id: r.user_id,
      subtitle: r.subtitle,
      growth_point: r.growth_point ?? "(no such col or null)",
      output_links: r.output_links ?? "(no such col or null)",
      output_images: r.output_images ?? "(no such col or null)",
      updated_at: r.updated_at,
    })),
  };
}

// 2) probe whether the new columns exist at all (selecting a missing column errors with 42703)
for (const col of ["growth_point", "output_links", "output_images", "subtitle"]) {
  const { error } = await db.from("cluster4_line_submissions").select(col).limit(1);
  out[`col_${col}`] = error ? `MISSING/ERROR: ${error.message}` : "exists";
}

// 3) currently-open lines (active + window covers now) and one user target each — repro fixtures
{
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("cluster4_lines")
    .select("id, part_type, main_title, is_active, submission_opens_at, submission_closes_at")
    .eq("is_active", true)
    .or(`submission_opens_at.is.null,submission_opens_at.lte.${nowIso}`)
    .or(`submission_closes_at.is.null,submission_closes_at.gte.${nowIso}`)
    .limit(5);
  out.openLines = { error: error?.message ?? null, count: data?.length ?? 0, rows: data ?? [] };
  const firstLineId = data?.[0]?.id ?? null;
  if (firstLineId) {
    const { data: tgts } = await db
      .from("cluster4_line_targets")
      .select("id, line_id, week_id, target_mode, target_user_id")
      .eq("line_id", firstLineId)
      .limit(3);
    out.openLineTargets = tgts ?? [];
  }
}

console.log(JSON.stringify(out, null, 2));
