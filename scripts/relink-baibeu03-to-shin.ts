/**
 * baibeu03@gmail.com 로그인 연결을 T강서현 → T신유진 으로 이전 (auth 연결만, 프로필 삭제 없음).
 *
 *   npx tsx --env-file=.env.local scripts/relink-baibeu03-to-shin.ts          # dry-run (변경 없음)
 *   npx tsx --env-file=.env.local scripts/relink-baibeu03-to-shin.ts --apply  # 실제 적용 + 검증
 *
 * 이전 대상 SoT:
 *  1. auth_accounts(google sub).user_id        → T신유진
 *  2. applicants(google sub).linked_user_id     → T신유진 (status approved 유지)
 *  3. user_profiles(T강서현).auth_email/contact_email → .test 플레이스홀더로 해제(삭제 아님)
 *  4. user_profiles(T신유진).auth_email/contact_email → baibeu03@gmail.com
 *
 * 순서: 3(강서현 해제) → 4(신유진 설정) → 1 → 2.  (auth_email 동시 중복 방지)
 * T강서현의 프로필/활동/snapshot row 는 보존한다.
 */
import { createClient } from "@supabase/supabase-js";
import { resolveGoogleAccountAccess } from "../../vraxium/lib/auth-account-access";
import { resolveUserProfileAccess } from "../../vraxium/lib/user-profile-access";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.argv.includes("--apply");

const EMAIL = "baibeu03@gmail.com";
const GOOGLE_SUB = "100794291990196871797";
const KANG_ID = "3330f4c3-5331-4632-bbe6-01a19017a089"; // T강서현 (기존)
const SHIN_ID = "9d73cad4-12ec-4bd8-a118-58f8cf705122"; // T신유진 (신규)
const KANG_PLACEHOLDER = "kang.seohyun@vraxium.test";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures += 1;
}

async function main() {
  console.log(`모드: ${APPLY ? "APPLY (실제 적용)" : "DRY-RUN (변경 없음)"}\n`);

  // ── 사전 안전 검증 ────────────────────────────────────────────────
  const { data: kang } = await sb
    .from("user_profiles")
    .select("user_id, display_name, auth_email, contact_email")
    .eq("user_id", KANG_ID)
    .maybeSingle();
  const { data: shin } = await sb
    .from("user_profiles")
    .select("user_id, display_name, auth_email, contact_email")
    .eq("user_id", SHIN_ID)
    .maybeSingle();
  check("사전: T강서현 프로필 존재 + 현재 baibeu03 연결", kang?.auth_email === EMAIL, kang);
  check("사전: T신유진 프로필 존재", shin?.display_name === "T신유진", shin);

  // T신유진 이 이미 다른 auth 계정에 연결돼 있으면 즉시 중단 (정책 4)
  const { data: shinAuth } = await sb.from("auth_accounts").select("id, provider_user_id").eq("user_id", SHIN_ID);
  const { data: shinAppl } = await sb.from("applicants").select("id").eq("linked_user_id", SHIN_ID);
  const shinFree = (shinAuth ?? []).length === 0 && (shinAppl ?? []).length === 0;
  check("사전: T신유진 이 다른 auth/applicant 에 미연결(안전)", shinFree, { auth: shinAuth, applicants: shinAppl });
  if (!shinFree) {
    console.log("\n⛔ T신유진 이 이미 연결되어 있어 작업을 중단합니다.");
    process.exit(2);
  }

  if (!APPLY) {
    console.log("\nDRY-RUN: 적용하려면 --apply 를 붙여 다시 실행하세요.");
    return;
  }

  // ── 적용 ─────────────────────────────────────────────────────────
  // 3) T강서현 해제 (auth_email 중복 방지를 위해 먼저)
  {
    const { error } = await sb
      .from("user_profiles")
      .update({ auth_email: KANG_PLACEHOLDER, contact_email: KANG_PLACEHOLDER })
      .eq("user_id", KANG_ID);
    check("적용 3) T강서현 auth_email/contact_email 해제(.test)", !error, error?.message);
  }
  // 4) T신유진 설정
  {
    const { error } = await sb
      .from("user_profiles")
      .update({ auth_email: EMAIL, contact_email: EMAIL })
      .eq("user_id", SHIN_ID);
    check("적용 4) T신유진 auth_email/contact_email = baibeu03", !error, error?.message);
  }
  // 1) auth_accounts.user_id
  {
    const { error } = await sb
      .from("auth_accounts")
      .update({ user_id: SHIN_ID, updated_at: new Date().toISOString() })
      .eq("provider", "google")
      .eq("provider_user_id", GOOGLE_SUB);
    check("적용 1) auth_accounts.user_id → T신유진", !error, error?.message);
  }
  // 2) applicants.linked_user_id
  {
    const { error } = await sb
      .from("applicants")
      .update({ linked_user_id: SHIN_ID, status: "approved" })
      .eq("provider", "google")
      .eq("provider_user_id", GOOGLE_SUB);
    check("적용 2) applicants.linked_user_id → T신유진", !error, error?.message);
  }

  // ── 사후 검증 ────────────────────────────────────────────────────
  console.log("\n── 사후 검증 ──");

  // resolveUserProfileAccess (email 경로) → T신유진
  const byEmail = await resolveUserProfileAccess(sb, { email: EMAIL });
  check(
    "resolveUserProfileAccess('baibeu03@gmail.com') → approved & T신유진",
    byEmail.status === "approved" && byEmail.profile.user_id === SHIN_ID,
    { status: byEmail.status, user_id: byEmail.status === "approved" ? byEmail.profile.user_id : null },
  );

  // resolveGoogleAccountAccess (sub 경로) → T신유진 (user_id 덮어쓰지 않음)
  const bySub = await resolveGoogleAccountAccess(sb, { providerUserId: GOOGLE_SUB, email: EMAIL, name: "바이브" });
  check(
    "resolveGoogleAccountAccess(sub) → approved & T신유진",
    bySub.status === "approved" && bySub.profile.user_id === SHIN_ID,
    { status: bySub.status, user_id: bySub.status === "approved" ? bySub.profile.user_id : null },
  );

  // auth_email 단일 매칭(중복 없음) 확인
  const { data: authMatches } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .eq("auth_email", EMAIL);
  check("user_profiles.auth_email=baibeu03 정확히 1명(T신유진)", (authMatches ?? []).length === 1 && authMatches![0].user_id === SHIN_ID, authMatches);

  // T강서현 더 이상 baibeu03 아님
  const { data: kangAfter } = await sb
    .from("user_profiles")
    .select("auth_email, contact_email")
    .eq("user_id", KANG_ID)
    .maybeSingle();
  check("T강서현 auth/contact 더 이상 baibeu03 아님(데이터 보존)", kangAfter?.auth_email === KANG_PLACEHOLDER, kangAfter);

  // auth_accounts / applicants 링크 확인
  const { data: aa } = await sb.from("auth_accounts").select("user_id").eq("provider_user_id", GOOGLE_SUB).maybeSingle();
  check("auth_accounts.user_id = T신유진", aa?.user_id === SHIN_ID, aa);
  const { data: ap } = await sb.from("applicants").select("linked_user_id, status").eq("provider_user_id", GOOGLE_SUB).maybeSingle();
  check("applicants.linked_user_id = T신유진 & approved", ap?.linked_user_id === SHIN_ID && ap?.status === "approved", ap);

  // T신유진 snapshot 상태 (재계산 필요 여부)
  const { data: snap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, is_stale, dto_version, updated_at")
    .eq("user_id", SHIN_ID)
    .maybeSingle();
  check("T신유진 weekly-cards snapshot 존재 & not stale(재계산 불필요)", !!snap && snap.is_stale === false, snap);

  console.log(failures === 0 ? "\n결과: 전체 통과 ✅" : `\n결과: ${failures}건 실패 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
