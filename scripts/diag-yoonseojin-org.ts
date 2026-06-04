import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const userId = "76a42307-f3b2-4c08-92ab-f339a20b7d38";
async function main() {
  const { data: p } = await sb.from("user_profiles").select("user_id, display_name, organization_slug, growth_status").eq("user_id", userId).maybeSingle();
  console.log("profile:", p);
  const { data: m } = await sb.from("test_user_markers").select("*").eq("user_id", userId);
  console.log("test_user_markers:", m);
}
main().catch((e) => { console.error(e); process.exit(1); });
