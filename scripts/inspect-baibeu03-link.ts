/**
 * READ-ONLY 진단 — baibeu03@gmail.com 의 현재 연결 상태 + T강서현 / T신유진 프로필 상태.
 *   npx tsx --env-file=.env.local scripts/inspect-baibeu03-link.ts
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EMAIL = "baibeu03@gmail.com";

function j(label: string, v: unknown) {
  console.log(`\n── ${label} ──`);
  console.log(JSON.stringify(v, null, 2));
}

async function main() {
  // 1) auth_accounts: email 또는 google sub 로 baibeu03 연결 row
  const { data: authByEmail } = await sb
    .from("auth_accounts")
    .select("id, provider, provider_user_id, email, display_name, user_id, updated_at")
    .ilike("email", EMAIL);
  j("auth_accounts WHERE email ILIKE baibeu03@gmail.com", authByEmail);

  // 2) applicants: google sub row + email row
  const { data: applicantsByEmail } = await sb
    .from("applicants")
    .select("id, name, email, provider, provider_user_id, status, linked_user_id, created_at")
    .ilike("email", EMAIL);
  j("applicants WHERE email ILIKE baibeu03@gmail.com", applicantsByEmail);

  // 3) user_profiles: auth_email / contact_email 로 baibeu03 매칭되는 프로필
  const { data: profByAuth } = await sb
    .from("user_profiles")
    .select("user_id, display_name, english_name, auth_email, contact_email, organization_slug, growth_status")
    .ilike("auth_email", EMAIL);
  j("user_profiles WHERE auth_email ILIKE baibeu03@gmail.com", profByAuth);

  const { data: profByContact } = await sb
    .from("user_profiles")
    .select("user_id, display_name, english_name, auth_email, contact_email, organization_slug, growth_status")
    .ilike("contact_email", EMAIL);
  j("user_profiles WHERE contact_email ILIKE baibeu03@gmail.com", profByContact);

  // 4) T강서현 / T신유진 프로필 (display_name 기준)
  const { data: kang } = await sb
    .from("user_profiles")
    .select("user_id, display_name, english_name, auth_email, contact_email, organization_slug, growth_status")
    .eq("display_name", "T강서현");
  j("user_profiles display_name = T강서현", kang);

  const { data: shin } = await sb
    .from("user_profiles")
    .select("user_id, display_name, english_name, auth_email, contact_email, organization_slug, growth_status")
    .eq("display_name", "T신유진");
  j("user_profiles display_name = T신유진", shin);

  // 혹시 display_name 에 공백/변형이 있을 수 있어 LIKE 도 확인
  const { data: kangLike } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .ilike("display_name", "%강서현%");
  j("user_profiles display_name ILIKE %강서현%", kangLike);
  const { data: shinLike } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .ilike("display_name", "%신유진%");
  j("user_profiles display_name ILIKE %신유진%", shinLike);

  // 5) 두 유저의 users row (source_system / legacy)
  const ids = [
    ...(kang ?? []).map((r) => r.user_id),
    ...(shin ?? []).map((r) => r.user_id),
  ].filter(Boolean) as string[];
  if (ids.length) {
    const { data: users } = await sb
      .from("users")
      .select("id, source_system, legacy_user_id, created_at")
      .in("id", ids);
    j("users (강서현/신유진)", users);

    // 6) T신유진 이 이미 다른 auth_accounts 에 링크돼 있는지
    const shinIds = (shin ?? []).map((r) => r.user_id).filter(Boolean) as string[];
    if (shinIds.length) {
      const { data: shinAuth } = await sb
        .from("auth_accounts")
        .select("id, provider, provider_user_id, email, display_name, user_id")
        .in("user_id", shinIds);
      j("auth_accounts WHERE user_id = T신유진 (이미 링크?)", shinAuth);

      const { data: shinApplicants } = await sb
        .from("applicants")
        .select("id, email, provider, provider_user_id, status, linked_user_id")
        .in("linked_user_id", shinIds);
      j("applicants WHERE linked_user_id = T신유진", shinApplicants);

      // 7) T신유진 snapshot 상태
      const { data: shinSnap } = await sb
        .from("cluster4_weekly_card_snapshots")
        .select("user_id, is_stale, dto_version, updated_at")
        .in("user_id", shinIds);
      j("cluster4_weekly_card_snapshots T신유진", shinSnap);
    }

    const kangIds = (kang ?? []).map((r) => r.user_id).filter(Boolean) as string[];
    if (kangIds.length) {
      const { data: kangSnap } = await sb
        .from("cluster4_weekly_card_snapshots")
        .select("user_id, is_stale, dto_version, updated_at")
        .in("user_id", kangIds);
      j("cluster4_weekly_card_snapshots T강서현", kangSnap);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
