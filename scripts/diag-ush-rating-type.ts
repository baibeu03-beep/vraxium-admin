import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  // 4.5 직접 update 시도 → DB 에러 메시지로 컬럼 타입 확인 (즉시 원복)
  const id = "b985712a-9f02-4013-a2e7-2480a22c6ee1";
  const { error } = await sb.from("user_season_histories").update({ rating: 4.5 }).eq("id", id);
  console.log("rating=4.5 direct update:", error ? `${error.code} ${error.message}` : "성공(원복 필요)");
  // 원복: rating 9 → 검증 시나리오 유지? 아니, 원래 4였음. 검증 끝났으니 4 로 복원은 마지막에. 지금은 9 유지.
  await sb.from("user_season_histories").update({ rating: 9 }).eq("id", id);
  // 테스트로 만든 weekly_review(mojibake) 정리
  const { error: delErr } = await sb.from("weekly_reviews").delete().eq("id", "62ba4bf2-a6d9-4c49-beb2-725769beca6e");
  console.log("테스트 weekly_review 삭제:", delErr ? delErr.message : "완료");
}
main().catch((e) => { console.error(e); process.exit(1); });
