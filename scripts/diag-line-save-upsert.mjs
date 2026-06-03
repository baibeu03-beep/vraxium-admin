// Replicate the EXACT upsert that /api/activity-details performs against the live DB,
// on a real currently-open target, then post-write select, then clean up.
// Answers: does the canonical write + onConflict('line_target_id,user_id') actually work?
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
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Real open target from the previous probe (competency line, open window 05-31..06-03):
const line_target_id = "e7c43cf8-acb2-4105-8ac2-5854bc574fb6";
const user_id = "b2e2d277-d40c-4cef-91cb-733b7d6e658a";

const subPayload = {
  line_target_id,
  user_id,
  subtitle: "[DIAG-PROBE] 자동검증 임시행 — 삭제 예정",
  growth_point: "diag growth",
  output_links: [{ url: "https://example.com/diag", label: "diag" }],
  output_images: [],
};
const SUB_SELECT = "id,line_target_id,user_id,subtitle,growth_point,output_links,output_images,updated_at";

const result = {};
const { data: subData, error: subErr } = await db
  .from("cluster4_line_submissions")
  .upsert(subPayload, { onConflict: "line_target_id,user_id" })
  .select(SUB_SELECT)
  .single();
result.upsert = { ok: !subErr && !!subData, error: subErr?.message ?? null, code: subErr?.code ?? null, row: subData ?? null };

// post-write select (exactly like the route's verify step)
const { data: verifyRow, error: verifyErr } = await db
  .from("cluster4_line_submissions")
  .select(SUB_SELECT)
  .eq("line_target_id", line_target_id)
  .eq("user_id", user_id)
  .maybeSingle();
result.postWriteSelect = { error: verifyErr?.message ?? null, row: verifyRow ?? null };

// cleanup — remove the diag row so the real user's page is untouched
const { error: delErr } = await db
  .from("cluster4_line_submissions")
  .delete()
  .eq("line_target_id", line_target_id)
  .eq("user_id", user_id);
result.cleanup = { deleted: !delErr, error: delErr?.message ?? null };

// confirm table empty again
const { count } = await db
  .from("cluster4_line_submissions")
  .select("id", { count: "exact", head: true });
result.tableCountAfterCleanup = count;

console.log(JSON.stringify(result, null, 2));
