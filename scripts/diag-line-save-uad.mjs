// Read-only: is the POST /api/activity-details endpoint being hit at all in prod?
// Both old code and a null-line_target_id request still write user_activity_details.
// If user_activity_details has recent rows but submissions is empty => API hit, line branch skipped
//   (= deployed-old-code OR runtime line_target_id=null).
// If user_activity_details ALSO has no recent rows => save never reaches API (admin-preview/demo path).
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
function loadEnv(p){for(const l of readFileSync(p,"utf8").split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);if(!m)continue;let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(m[1] in process.env))process.env[m[1]]=v;}}
loadEnv(".env.local");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const out = {};
const { data, error, count } = await db
  .from("user_activity_details")
  .select("user_id,week_id,activity_type_id,sub_title,updated_at", { count: "exact" })
  .order("updated_at", { ascending: false })
  .limit(8);
out.userActivityDetails = {
  error: error?.message ?? null,
  totalRows: count,
  latestUpdatedAt: data?.[0]?.updated_at ?? null,
  recent: (data ?? []).map((r) => ({
    user_id: r.user_id, week_id: r.week_id, activity_type_id: r.activity_type_id,
    sub_title: r.sub_title, updated_at: r.updated_at,
  })),
};
console.log(JSON.stringify(out, null, 2));
