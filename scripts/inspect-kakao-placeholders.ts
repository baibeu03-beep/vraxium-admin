/** READ-ONLY — "카카오 사용자" placeholder 프로필들이 비어있는지/데이터 보유인지 점검. */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PLACEHOLDERS: Array<{ email: string; id: string }> = [
  { email: "ar220919.kaka@gmail.com", id: "1ca828bd-ffd3-4008-ba45-cf37c01171fb" },
  { email: "appley13@kakao.com", id: "60698e6b-34f9-47b0-9c78-2c22f7c08a93" },
  { email: "cozypen09@kakao.com", id: "69fbb2b3-9821-46da-b0d2-7d43b1e1e2b5" },
  { email: "miraeum26@kakao.com", id: "c3ca54c0-1fb7-4b2d-9ed1-b6e7c9775d73" },
  { email: "project_service@kakao.com", id: "9a02951e-c5ee-4778-929c-8da5e0956c77" },
  { email: "ddfjlaeia_fadg@kakao.com", id: "3e737e89-02da-4c95-8fe5-68a06d62019a" },
  { email: "adjfeualdq.kfka@kakao.com", id: "f7fdd629-0304-4cd3-a0c5-48d78a56e628" },
];

async function count(table: string, col: string, id: string): Promise<number> {
  const { count, error } = await sb.from(table).select("*", { count: "exact", head: true }).eq(col, id);
  if (error) return -1; // 테이블/컬럼 부재
  return count ?? 0;
}

async function main() {
  const ids = PLACEHOLDERS.map((p) => p.id);
  const { data: users } = await sb.from("users").select("id, source_system, legacy_user_id, created_at").in("id", ids);
  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", ids);
  const markerSet = new Set((markers ?? []).map((m) => m.user_id));
  const { data: profs } = await sb.from("user_profiles").select("user_id, created_at, current_team_name, current_part_name").in("user_id", ids);

  for (const { email, id } of PLACEHOLDERS) {
    const u = (users ?? []).find((x) => x.id === id);
    const p = (profs ?? []).find((x) => x.user_id === id);
    const mem = await count("user_memberships", "user_id", id);
    const uws = await count("user_week_statuses", "user_id", id);
    const uad = await count("user_activity_details", "user_id", id);
    const uwp = await count("user_weekly_points", "user_id", id);
    const ar = await count("activity_records", "user_id", id);
    const ush = await count("user_season_histories", "user_id", id);
    console.log(`\n▶ ${email}  (${id})`);
    console.log(`   users: source_system=${u?.source_system ?? null} legacy=${u?.legacy_user_id ?? null} created=${u?.created_at}`);
    console.log(`   test_marker=${markerSet.has(id)}  team=${p?.current_team_name ?? null}/${p?.current_part_name ?? null}  profile_created=${p?.created_at}`);
    console.log(`   memberships=${mem} week_statuses=${uws} activity_details=${uad} weekly_points=${uwp} activity_records=${ar} season_histories=${ush}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
