// diag: ?ㅼ쑀?(鍮꾪뀒?ㅽ꽣) userId ?섑뵆 議고쉶
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { supabaseAdmin } = await import("../lib/supabaseAdmin");
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const t = new Set((markers ?? []).map((x: any) => x.user_id));
  console.log("marker count:", t.size);
  const { data: profs, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,activity_started_at,created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  const real = (profs ?? []).filter((p: any) => !t.has(p.user_id));
  console.log("profiles fetched:", (profs ?? []).length, "non-tester:", real.length);
  console.log(JSON.stringify(real.slice(0, 8), null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
