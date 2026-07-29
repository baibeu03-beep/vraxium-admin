// 521 구간에서 재계산 실패한 42명의 snapshot 행이 실제로 최신(v50)·non-stale 인지 확인.
//   run: npx tsx --env-file=.env.local scripts/_verify-v50-failed-42.ts
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const IDS = ["e37277ec-dd69-49da-9527-232bff59e7c1","e4dcb97e-a515-4ec5-a91e-32ca4e629dae","e3ecedf6-8aa7-427c-8b34-e705a8f1fa43","e503a954-2492-40e6-a4e2-822521a5bd33","e3f957c4-367b-419f-99a7-4e2172d0918e","e54d55f6-6b65-4f06-a22e-6895c3a43768","e3c9d248-6472-405b-a25e-c8ff9ac39101","e5cc1fc9-d367-405d-be03-660bd4105d13","e60d5a31-0f5f-4d85-a422-7fdbd25857bf","e5efce7f-66cd-49a9-9c76-b970037db73d","e649370f-ba2c-4d2f-b642-6800cb078d54","e6574586-6279-41cc-ae36-1c9dc3078bc3","e6b25f1b-3bc9-40fb-af87-4f2f44a9e6df","e6c65e0e-9986-4c08-94cd-d4c779853ebe","e6d66843-ae50-4672-9421-d8a04e9b55f2","e752c775-ac53-4ab1-a1c6-bbd988633e8c","e81c8b30-20a2-4a10-bf2c-8c3ca474e4e7","e7610025-6fa7-4227-b64b-cd3bb632d7be","e89a2163-9271-4a59-876f-63292846abbe","e8c1f6df-9de1-4e41-9870-fd81499f4364","e9a9cacc-7db0-4db6-aeb7-6a1fd6591cc4","ea05ce8d-80c4-455d-96e4-459417878551","ea286f9d-fb5b-492e-a081-cd5c200a4455","ea37d14d-d0ca-43f8-ab8d-632cf31f4fab","ea970f61-7adf-4cbf-8b3c-92172b06d941","eb15f3f3-6a37-4890-933c-24582efe6897","ebb7eb40-76ba-4d51-8765-6966db7e587b","ebd7cf95-4e48-4ec4-9cf9-4392be5e59ac","ec0075e2-44d2-42a8-9e63-53a30cbcfa75","ec11fe34-0cba-4bbc-afae-6d7514fdf57e","ec3344e2-7fd2-44b6-9c85-46c44535f482","ec365256-63f7-42d4-a23e-90731391c9a2","eca5f88e-ee7a-4c78-8ae2-469b295b5b1b","ecaa1a4c-c72a-4ef5-9657-faa7414a241d","ecb12eec-1dab-40ba-ad14-552af3f49ea6","ed261ac9-d211-4838-a7fe-327b7878c2d7","ed6894d3-ada0-4d26-9ee6-e6c32743845a","eda82067-9c13-4253-b774-5d025f8e28c5","edf49916-ee63-4fe3-bba0-f07bf3360c03","edfe7e58-4681-4d40-ba46-199fc9d99d82","ee287145-43cc-4ab2-bf6e-ef5b34d38c60","ee9bf53b-b7cf-4a27-8aeb-fa4a7ec605eb"];

async function main() {
  console.log(`기준 v${WEEKLY_CARDS_DTO_VERSION} · 확인 대상 ${IDS.length}명 (521 구간 실패분)`);
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,card_count,computed_at")
    .in("user_id", IDS);
  if (error) throw error;
  const rows = (data ?? []) as { user_id: string; dto_version: number; is_stale: boolean; card_count: number; computed_at: string }[];

  const missing = IDS.filter((id) => !rows.some((r) => r.user_id === id));
  const oldVer = rows.filter((r) => r.dto_version !== WEEKLY_CARDS_DTO_VERSION);
  const stale = rows.filter((r) => r.is_stale);
  const empty = rows.filter((r) => r.card_count === 0);
  const times = rows.map((r) => r.computed_at).sort();

  console.log(`행 존재      : ${rows.length}/${IDS.length}${missing.length ? ` (누락 ${missing.length}: ${missing.join(", ")})` : ""}`);
  console.log(`구버전       : ${oldVer.length}${oldVer.length ? " → " + oldVer.map((r) => `${r.user_id}:v${r.dto_version}`).join(", ") : ""}`);
  console.log(`is_stale     : ${stale.length}${stale.length ? " → " + stale.map((r) => r.user_id).join(", ") : ""}`);
  console.log(`card_count=0 : ${empty.length}${empty.length ? " → " + empty.map((r) => r.user_id).join(", ") : ""}`);
  console.log(`computed_at  : ${times[0]} ~ ${times[times.length - 1]}`);
  const ok = missing.length === 0 && oldVer.length === 0 && stale.length === 0;
  console.log(ok ? "\n✅ 42명 전원 최신 버전·non-stale." : "\n⚠ 잔여 문제 있음 — 위 목록 확인.");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
