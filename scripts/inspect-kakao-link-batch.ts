/**
 * READ-ONLY 진단 — 7명 엥크레(encre) 테스트 사용자 카카오 이메일 연결 사전 점검.
 *   npx tsx --env-file=.env.local scripts/inspect-kakao-link-batch.ts
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const PAIRS: Array<{ name: string; email: string }> = [
  { name: "T임시우", email: "ar220919.kaka@gmail.com" },
  { name: "T황민서", email: "appley13@kakao.com" },
  { name: "T조예린", email: "cozypen09@kakao.com" },
  { name: "T임다인", email: "miraeum26@kakao.com" },
  { name: "T장소율", email: "project_service@kakao.com" },
  { name: "T정하은", email: "ddfjlaeia_fadg@kakao.com" },
  { name: "T정시현", email: "adjfeualdq.kfka@kakao.com" },
];

function norm(e: string) {
  return e.trim().toLowerCase();
}

async function main() {
  for (const { name, email } of PAIRS) {
    const e = norm(email);
    console.log(`\n========================================`);
    console.log(`▶ ${name} / ${email}`);
    console.log(`========================================`);

    // ── 이메일이 이미 어딘가 연결돼 있는지 ──
    const { data: aa } = await sb
      .from("auth_accounts")
      .select("id, provider, provider_user_id, email, user_id")
      .ilike("email", e);
    console.log(`auth_accounts(email):`, JSON.stringify(aa ?? []));

    const { data: ap } = await sb
      .from("applicants")
      .select("id, name, email, provider, provider_user_id, status, linked_user_id")
      .ilike("email", e);
    console.log(`applicants(email):`, JSON.stringify(ap ?? []));

    const { data: byAuth } = await sb
      .from("user_profiles")
      .select("user_id, display_name, organization_slug, auth_email, contact_email")
      .ilike("auth_email", e);
    console.log(`user_profiles(auth_email):`, JSON.stringify(byAuth ?? []));

    const { data: byContact } = await sb
      .from("user_profiles")
      .select("user_id, display_name, organization_slug, auth_email, contact_email")
      .ilike("contact_email", e);
    console.log(`user_profiles(contact_email):`, JSON.stringify(byContact ?? []));

    // ── T사용자 프로필 (이름 정확 매칭) ──
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id, display_name, organization_slug, auth_email, contact_email, growth_status")
      .eq("display_name", name);
    console.log(`user_profiles(display_name=${name}) [${(profs ?? []).length}건]:`, JSON.stringify(profs ?? []));

    const ids = (profs ?? []).map((p) => p.user_id).filter(Boolean) as string[];
    if (ids.length) {
      const { data: markers } = await sb
        .from("test_user_markers")
        .select("*")
        .in("user_id", ids);
      console.log(`test_user_markers:`, JSON.stringify(markers ?? []));

      // T사용자가 이미 다른 auth/applicant 에 연결돼 있는지
      const { data: linkedAa } = await sb
        .from("auth_accounts")
        .select("id, provider, provider_user_id, email, user_id")
        .in("user_id", ids);
      console.log(`auth_accounts(user_id=T):`, JSON.stringify(linkedAa ?? []));

      const { data: linkedAp } = await sb
        .from("applicants")
        .select("id, email, provider, status, linked_user_id")
        .in("linked_user_id", ids);
      console.log(`applicants(linked_user_id=T):`, JSON.stringify(linkedAp ?? []));

      const { data: users } = await sb
        .from("users")
        .select("id, source_system, legacy_user_id")
        .in("id", ids);
      console.log(`users:`, JSON.stringify(users ?? []));

      const { data: snap } = await sb
        .from("cluster4_weekly_card_snapshots")
        .select("user_id, is_stale, dto_version, updated_at")
        .in("user_id", ids);
      console.log(`snapshot:`, JSON.stringify(snap ?? []));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
