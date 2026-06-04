// T조예린 user_season_histories(고객 로컬 폴백 source) 확인.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const uid = "98807fea-2137-4160-ba5c-dedcbdced0e8";
  const { data: ush, error } = await sb.from("user_season_histories").select("*").eq("user_id", uid);
  if (error) return console.log("err", error.message);
  console.log(`user_season_histories ${ush!.length}행`);
  for (const h of ush!) console.log(JSON.stringify(h));
  const ids = ush!.map((h: any) => h.season_id).filter(Boolean);
  if (ids.length) {
    const { data: seasons } = await sb.from("seasons").select("id,name,year,start_date,end_date").in("id", ids);
    for (const s of seasons ?? []) console.log("season:", JSON.stringify(s));
  }
}
main();
