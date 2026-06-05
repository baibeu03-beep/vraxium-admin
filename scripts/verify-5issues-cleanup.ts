/** 검증 후 정리: T윤도현 ush rating 원복(9→4). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { error } = await sb.from("user_season_histories")
    .update({ rating: 4, review: "주간 통계는 아직 최종 집계가 완료되지 않은 상태다." })
    .eq("id", "b985712a-9f02-4013-a2e7-2480a22c6ee1");
  console.log("ush rating 원복:", error ? error.message : "완료(rating=4)");
  const { data } = await sb.from("user_season_histories").select("rating,review").eq("id", "b985712a-9f02-4013-a2e7-2480a22c6ee1").maybeSingle();
  console.log("현재 값:", JSON.stringify(data));
}
main().catch((e) => { console.error(e); process.exit(1); });
