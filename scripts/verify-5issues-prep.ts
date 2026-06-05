/**
 * 검증 준비: T윤도현(테스트 유저) edit window 연장(weekly_reviews w13 2행 동시 OPEN 재현) +
 * season_review 윈도우 개방 + ush row 확인. 테스트 유저 한정 쓰기.
 *   npx tsx --env-file=.env.local scripts/verify-5issues-prep.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (test_user_markers 등재)
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const W16 = "9af934a2-5c11-4932-b800-5bdb83183e68";

async function main() {
  // 테스터 확인 (방어)
  const { data: tm } = await sb.from("test_user_markers").select("user_id").eq("user_id", UID).maybeSingle();
  if (!tm) throw new Error("테스트 유저 아님 — 중단");

  const opened = new Date(Date.now() - 60_000).toISOString();
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();

  // 1) weekly_reviews: w13 + w16 두 행 동시 OPEN (403 재현 조건 유지한 채 수정 검증)
  for (const wid of [W13, W16]) {
    const { error } = await sb.from("user_edit_windows")
      .update({ opened_at: opened, expires_at: expires })
      .eq("user_id", UID).eq("resource_key", "cluster4.weekly_reviews").eq("week_id", wid);
    if (error) throw error;
  }

  // 2) season_review 윈도우 (비주간 자원) — 없으면 insert
  const { data: srRow } = await sb.from("user_edit_windows").select("id")
    .eq("user_id", UID).eq("resource_key", "cluster4.season_review").is("week_id", null).maybeSingle();
  if (srRow) {
    await sb.from("user_edit_windows").update({ opened_at: opened, expires_at: expires }).eq("id", srRow.id);
  } else {
    const { error } = await sb.from("user_edit_windows").insert({
      user_id: UID, resource_key: "cluster4.season_review", week_id: null,
      opened_at: opened, expires_at: expires, note: "5이슈 검증용 (자동)",
    });
    if (error) throw error;
  }

  // 3) ush row + 기존 rating (검증 후 복원용)
  const { data: ush } = await sb.from("user_season_histories").select("id,season_id,rating,review").eq("user_id", UID);
  console.log("ush rows:", JSON.stringify(ush, null, 1));

  // 4) 기존 weekly_review (w13) 존재 여부 — 있으면 POST 대신 PUT 시나리오
  const { data: wr } = await sb.from("weekly_reviews").select("id,rating,content").eq("user_id", UID).eq("week_card_id", W13);
  console.log("기존 weekly_reviews(w13):", JSON.stringify(wr));

  // 5) 열린 윈도우 현황 출력
  const now = new Date().toISOString();
  const { data: wins } = await sb.from("user_edit_windows")
    .select("resource_key,week_id,opened_at,expires_at").eq("user_id", UID);
  for (const w of wins ?? []) console.log(`win ${w.resource_key} week=${w.week_id ?? "NULL"} ${w.opened_at <= now && w.expires_at > now ? "[OPEN]" : "[closed]"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
