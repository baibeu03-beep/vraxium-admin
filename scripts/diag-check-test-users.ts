/** READ-ONLY: 검증 대상 유저들의 display_name(테스트 유저 여부) 확인. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const ids = [
    "19cb4129-ba73-4685-9912-7d9d4ed3768b",
    "247021bc-374b-48f4-8d49-b181d149ee33",
    "0a113e53-b678-40d1-b51c-1278e1c3f0fa",
    "5fe0f152-3e4c-4313-8203-6fb6002c5393",
    "13b8e55e-ff49-43f3-a01f-cb68bfb74581",
  ];
  const { data } = await supabaseAdmin.from("user_profiles").select("user_id,display_name").in("user_id", ids);
  console.log(JSON.stringify(data, null, 2));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
