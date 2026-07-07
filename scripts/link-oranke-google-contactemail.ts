/**
 * oranke 테스트 사용자 10명 ↔ Google 계정 1:1 사전연결 (contact_email 자동연결 경로).
 * ─────────────────────────────────────────────────────────────────────
 * 방식: 각 테스트 사용자의 user_profiles.contact_email(+auth_email)을 해당 gmail 로 설정한다.
 *   · 10명 전원 PMS 이관(migrated) 사용자 → 첫 Google 로그인 시 고객앱
 *     resolveGoogleAccountAccess 의 tryAutoLinkGoogleByContactEmail 경로가 발동,
 *     기존 테스트 사용자에 자동 연결되고 auth_accounts row 는 그때 실제 sub 으로 생성된다.
 *   · 신규 user/user_profiles 생성 없음 — 기존 row UPDATE 만. auth_accounts 직접 삽입 없음(sub 부재).
 *   · 백업 JSON 기록 → --rollback 으로 정확히 원복.
 *
 * 안전 가드(엄수): 대상 전원 test_user_markers 등재 + org=oranke + display_name 일치 +
 *   기존 google auth_accounts 없음 + gmail 이 다른 프로필에 미사용. 하나라도 실패 시 전체 중단.
 *
 * 사용법:
 *   미리보기: npx tsx --env-file=.env.local scripts/link-oranke-google-contactemail.ts
 *   적용:     ... --apply
 *   롤백:     ... --rollback
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const BACKUP_PATH = resolve(process.cwd(), "claudedocs", "link-oranke-google-contactemail-backup.json");
const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const norm = (s: string) => s.trim().toLowerCase();

type Target = { email: string; user_id: string; name: string };
const TARGETS: Target[] = [
  { email: "blacksmith0.official@gmail.com", user_id: "63813dc4-9dec-4511-83be-1f54196d09cf", name: "T류민서" },
  { email: "forlovenlemon@gmail.com", user_id: "28a39131-a719-4264-b2a4-96dbda64cbb6", name: "T박유진" },
  { email: "gmanggo791@gmail.com", user_id: "edfe7e58-4681-4d40-ba46-199fc9d99d82", name: "T김주원" },
  { email: "lavenderbeam94@gmail.com", user_id: "fd2afa0a-48c8-423c-b3a8-df417990002a", name: "T서도윤" },
  { email: "cosmicmango12@gmail.com", user_id: "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a", name: "T류건영" },
  { email: "softberry688@gmail.com", user_id: "ddce842a-23a4-49a1-b947-78b2a3f9ca64", name: "T권예준" },
  { email: "cloudyfox728@gmail.com", user_id: "dff09eb2-6534-42de-99bd-8bf2ed315c01", name: "T최선우" },
  { email: "starlake1022@gmail.com", user_id: "3ba642d8-d658-4e87-8e15-3afdab8415c2", name: "T여하은" },
  { email: "orangemoon554@gmail.com", user_id: "020ec835-1ead-4ef5-adce-d0d97585beaa", name: "T고수림" },
  { email: "silverpine833@gmail.com", user_id: "5ce78bd8-126f-4636-b6a9-a43031a21930", name: "T오지우" },
];

type Backup = { user_id: string; name: string; email: string; before_auth_email: string | null; before_contact_email: string | null };

async function main() {
  const markerSet = await fetchTestUserMarkerIds();

  // ── ROLLBACK ──
  if (ROLLBACK) {
    if (!existsSync(BACKUP_PATH)) { console.log("백업 없음 — 원복 대상 없음."); return; }
    const backup: Backup[] = JSON.parse(readFileSync(BACKUP_PATH, "utf8"));
    let restored = 0;
    for (const b of backup) {
      const { error } = await supabaseAdmin
        .from("user_profiles")
        .update({ auth_email: b.before_auth_email, contact_email: b.before_contact_email })
        .eq("user_id", b.user_id);
      if (error) { console.log(`  ✗ ${b.name}: ${error.message}`); continue; }
      console.log(`  ↩ ${b.name} → auth_email=${b.before_auth_email} contact_email=${b.before_contact_email}`);
      restored++;
    }
    console.log(`✅ 롤백 ${restored}/${backup.length}건`);
    return;
  }

  // ── 사전 안전검증 (전건) ──
  console.log(`대상 ${TARGETS.length}명 사전 안전검증...\n`);
  const backup: Backup[] = [];
  let bad = 0;
  for (const t of TARGETS) {
    const e = norm(t.email);
    const { data: prof } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug,auth_email,contact_email").eq("user_id", t.user_id).maybeSingle();
    const p = prof as any;
    const { data: usr } = await supabaseAdmin
      .from("users").select("id,source_system,legacy_user_id").eq("id", t.user_id).maybeSingle();
    const { data: gAa } = await supabaseAdmin
      .from("auth_accounts").select("id").eq("provider", "google").eq("user_id", t.user_id);
    // gmail 이 다른 프로필의 auth_email/contact_email 로 이미 쓰이는지
    const { data: authDup } = await supabaseAdmin
      .from("user_profiles").select("user_id").ilike("auth_email", e).neq("user_id", t.user_id);
    const { data: contactDup } = await supabaseAdmin
      .from("user_profiles").select("user_id").ilike("contact_email", e).neq("user_id", t.user_id);
    const { data: emailAa } = await supabaseAdmin
      .from("auth_accounts").select("id,user_id").ilike("email", e);

    const migrated = !!((usr as any)?.source_system ?? (usr as any)?.legacy_user_id);
    const checks = {
      marker: markerSet.has(t.user_id),
      org: p?.organization_slug === "oranke",
      name: p?.display_name === t.name,
      noGoogleLink: (gAa ?? []).length === 0,
      migrated,
      emailFree: (authDup ?? []).length === 0 && (contactDup ?? []).length === 0 && (emailAa ?? []).length === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    console.log(`${ok ? "✅" : "❌"} ${t.name} / ${t.email} — ${JSON.stringify(checks)}`);
    if (!ok) { bad++; continue; }
    backup.push({ user_id: t.user_id, name: t.name, email: e, before_auth_email: p?.auth_email ?? null, before_contact_email: p?.contact_email ?? null });
  }
  if (bad > 0) { console.log(`\n⛔ 사전검증 실패 ${bad}건 — 전체 중단(무변경).`); process.exit(2); }
  console.log(`\n사전 안전검증 ${backup.length}/${TARGETS.length} 통과`);

  // 신규 user 미생성 확인용 — 적용 전 users/profile 총건수 스냅샷
  const { count: usersBefore } = await supabaseAdmin.from("users").select("id", { count: "exact", head: true });
  const { count: profBefore } = await supabaseAdmin.from("user_profiles").select("user_id", { count: "exact", head: true });

  if (!APPLY) { console.log("\n(미리보기 — 적용 --apply)"); return; }

  // ── 적용 (기존 row UPDATE 만) ──
  console.log(`\n적용 시작...`);
  let ok = 0;
  for (const b of backup) {
    const { error } = await supabaseAdmin
      .from("user_profiles")
      .update({ auth_email: b.email, contact_email: b.email })
      .eq("user_id", b.user_id);
    if (error) { console.log(`  ✗ ${b.name}: ${error.message}`); continue; }
    console.log(`  ✓ ${b.name}: contact_email/auth_email = ${b.email}`);
    ok++;
  }
  mkdirSync(dirname(BACKUP_PATH), { recursive: true });
  writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2), "utf8");

  // 신규 user 미생성 확인
  const { count: usersAfter } = await supabaseAdmin.from("users").select("id", { count: "exact", head: true });
  const { count: profAfter } = await supabaseAdmin.from("user_profiles").select("user_id", { count: "exact", head: true });
  console.log(`\n✅ 적용 ${ok}/${backup.length}건 → 백업 ${BACKUP_PATH}`);
  console.log(`신규 생성 확인: users ${usersBefore}→${usersAfter}(Δ${(usersAfter ?? 0) - (usersBefore ?? 0)}) · user_profiles ${profBefore}→${profAfter}(Δ${(profAfter ?? 0) - (profBefore ?? 0)})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
