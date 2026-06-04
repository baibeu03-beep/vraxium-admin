/** READ-ONLY: T최수빈 membership_level + weekly-cards 카드 헤더 membershipStatusLabel 확인. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const USER_ID = "36138fb1-6fea-4b22-b6d2-9c46cba47314";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("user_memberships")
    .select("membership_level,membership_state,is_current,team_name,part_name")
    .eq("user_id", USER_ID);
  console.log("memberships:", JSON.stringify({ error: error?.message ?? null, rows: data }, null, 2));
  const { data: p, error: pe } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,full_name")
    .eq("user_id", USER_ID)
    .maybeSingle();
  console.log("profile:", JSON.stringify({ error: pe?.message ?? null, row: p }));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
