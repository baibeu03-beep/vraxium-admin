/**
 * seasons:null 진단 — user_season_histories.season_id 가 가리키는 seasons row 가
 * 실제 존재하는지, RLS/외래키/대소문자 문제인지 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-season-join-null.ts <season_id> [userId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const SEASON_ID = process.argv[2] ?? "33333358-42e4-403b-a726-caa6459ae7e9";
const USER_ID = process.argv[3];

// service role: RLS 우회 (anon/authenticated 와 결과 비교용)
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// anon: 고객 프론트가 실제로 사용하는 키와 동일한 RLS 경로
const anon = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

async function main() {
  console.log("=== 1) seasons row 직접 조회 (service role, RLS 우회) ===");
  const { data: seasonAdmin, error: seasonAdminErr } = await admin
    .from("seasons")
    .select("*")
    .eq("id", SEASON_ID)
    .maybeSingle();
  console.log("error:", seasonAdminErr?.message ?? null);
  console.log("row:", JSON.stringify(seasonAdmin, null, 2));

  console.log("\n=== 2) seasons row 조회 (anon key, 프론트와 동일 RLS) ===");
  const { data: seasonAnon, error: seasonAnonErr } = await anon
    .from("seasons")
    .select("*")
    .eq("id", SEASON_ID)
    .maybeSingle();
  console.log("error:", seasonAnonErr?.message ?? null);
  console.log("row:", JSON.stringify(seasonAnon, null, 2));

  console.log("\n=== 3) user_season_histories 해당 season_id 행 (service role) ===");
  const { data: ushAll, error: ushErr } = await admin
    .from("user_season_histories")
    .select("*")
    .eq("season_id", SEASON_ID);
  console.log("error:", ushErr?.message ?? null);
  console.log("count:", ushAll?.length ?? 0);
  console.log(JSON.stringify(ushAll, null, 2));

  if (USER_ID) {
    console.log(`\n=== 4) 프론트와 동일한 join 쿼리 재현 (anon, userId=${USER_ID}) ===`);
    const { data: joined, error: joinErr } = await anon
      .from("user_season_histories")
      .select("*, seasons(*)")
      .eq("user_id", USER_ID);
    console.log("error:", joinErr?.message ?? null);
    console.log(JSON.stringify(joined, null, 2));

    console.log(`\n=== 4b) 동일 join 쿼리 (service role, userId=${USER_ID}) ===`);
    const { data: joinedAdmin, error: joinAdminErr } = await admin
      .from("user_season_histories")
      .select("*, seasons(*)")
      .eq("user_id", USER_ID);
    console.log("error:", joinAdminErr?.message ?? null);
    console.log(JSON.stringify(joinedAdmin, null, 2));
  }

  console.log("\n=== 5) 전체 seasons 목록 (id, key, 기간) ===");
  const { data: allSeasons } = await admin
    .from("seasons")
    .select("id, season_key, start_date, end_date")
    .order("start_date", { ascending: true });
  console.log(JSON.stringify(allSeasons, null, 2));
}

main().then(() => process.exit(0));
