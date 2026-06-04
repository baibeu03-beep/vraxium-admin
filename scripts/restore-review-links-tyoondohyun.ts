// 검증 사이클 후 T윤도현 리뷰 링크 원상 복구 (service role 직접 — API 순서검증 비대상)
//   원본 상태: week 3 + week 30 = 같은 유튜브 링크, user_cluster2.cluving_review_link 동일.
//   (30만 선채움은 레거시 백필 형태 — API 로는 재현 불가(정책상 차단)라 직접 복원)
import { config } from "dotenv";
config({ path: ".env.local" });

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const URL_ORIG = "https://www.youtube.com/watch?v=3tryG8l5ulY&list=RD3tryG8l5ulY&start_radio=1";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const now = new Date().toISOString();
  const { error: e1 } = await sb.from("user_review_links").upsert(
    [
      { user_id: UID, week_index: 3, url: URL_ORIG, label: "3 weeks", is_visible: true, updated_at: now },
      { user_id: UID, week_index: 30, url: URL_ORIG, label: "Total Complete", is_visible: true, updated_at: now },
    ],
    { onConflict: "user_id,week_index" },
  );
  if (e1) throw e1;
  const { error: e2 } = await sb
    .from("user_cluster2")
    .upsert({ user_id: UID, cluving_review_link: URL_ORIG, updated_at: now }, { onConflict: "user_id" });
  if (e2) throw e2;

  const { data } = await sb
    .from("user_review_links")
    .select("week_index,url")
    .eq("user_id", UID)
    .order("week_index");
  console.log("복구 후:", (data ?? []).filter((r: any) => r.url).map((r: any) => r.week_index));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
