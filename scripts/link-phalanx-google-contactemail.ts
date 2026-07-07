/**
 * phalanx 테스트 사용자 8명 ↔ Google 계정 1:1 사전연결 (contact_email 자동연결 경로).
 * ─────────────────────────────────────────────────────────────────────
 * oranke 판(scripts/link-oranke-google-contactemail.ts)과 동일 방식·가드.
 *   · 각 테스트 사용자의 user_profiles.contact_email(+auth_email)을 gmail 로 설정 →
 *     첫 Google 로그인 시 고객앱 resolveGoogleAccountAccess.tryAutoLinkGoogleByContactEmail
 *     (migrated 사용자 한정) 발동 → 기존 테스트 사용자에 자동연결, auth_accounts 는 그때 실제 sub 으로 생성.
 *   · 신규 user/user_profiles 생성 없음(기존 row UPDATE 만). 백업 JSON → --rollback 원복.
 *
 * 사용법:
 *   미리보기: npx tsx --env-file=.env.local scripts/link-phalanx-google-contactemail.ts
 *   적용:     ... --apply
 *   롤백:     ... --rollback
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const BACKUP_PATH = resolve(process.cwd(), "claudedocs", "link-phalanx-google-contactemail-backup.json");
const APPLY = process.argv.includes("--apply");
const ROLLBACK = process.argv.includes("--rollback");
const ORG = "phalanx";
const norm = (s: string) => s.trim().toLowerCase();

type Target = { email: string; user_id: string; name: string };
const TARGETS: Target[] = [
  { email: "flowery.through@gmail.com", user_id: "7e15f412-65be-481c-8525-460b161244ca", name: "T이하준" },   // 운영/팀장
  { email: "boohoo.rundown@gmail.com", user_id: "00b75923-2109-4214-806a-37667d64ac5e", name: "T강민지" },    // 운영/응대
  { email: "finally.despite@gmail.com", user_id: "bd57f30b-308f-4fbb-a7b7-71d76b3ce73a", name: "T임수빈" },   // 운영/정책
  { email: "oranke.healthcare@gmail.com", user_id: "3fec1a7e-4a88-4bc7-8da8-9eb9daff6f8a", name: "T범혜민" }, // 전략/기획
  { email: "oranke.it@gmail.com", user_id: "59c22d30-aece-4855-9958-bf34f8795d2a", name: "T이선욱" },         // 전략/리서치
  { email: "g8601053@gmail.com", user_id: "0a113e53-b678-40d1-b51c-1278e1c3f0fa", name: "T김성훈" },          // 제품실험/검수
  { email: "sidecar651@gmail.com", user_id: "f26e0bab-e138-41e6-a28b-676036a6a5aa", name: "T권지민" },        // 제품실험/데이터
  { email: "opening185@gmail.com", user_id: "fcfbe22a-05d2-4260-bfa4-c716d11d38bd", name: "T조현우" },        // 제품실험/앱
];

type Backup = { user_id: string; name: string; email: string; before_auth_email: string | null; before_contact_email: string | null };

async function main() {
  const markerSet = await fetchTestUserMarkerIds();

  if (ROLLBACK) {
    if (!existsSync(BACKUP_PATH)) { console.log("백업 없음 — 원복 대상 없음."); return; }
    const backup: Backup[] = JSON.parse(readFileSync(BACKUP_PATH, "utf8"));
    let restored = 0;
    for (const b of backup) {
      const { error } = await supabaseAdmin
        .from("user_profiles").update({ auth_email: b.before_auth_email, contact_email: b.before_contact_email }).eq("user_id", b.user_id);
      if (error) { console.log(`  ✗ ${b.name}: ${error.message}`); continue; }
      console.log(`  ↩ ${b.name} → auth_email=${b.before_auth_email} contact_email=${b.before_contact_email}`);
      restored++;
    }
    console.log(`✅ 롤백 ${restored}/${backup.length}건`);
    return;
  }

  console.log(`대상 ${TARGETS.length}명 사전 안전검증...\n`);
  const backup: Backup[] = [];
  let bad = 0;
  for (const t of TARGETS) {
    const e = norm(t.email);
    const { data: prof } = await supabaseAdmin
      .from("user_profiles").select("user_id,display_name,organization_slug,auth_email,contact_email").eq("user_id", t.user_id).maybeSingle();
    const p = prof as any;
    const { data: usr } = await supabaseAdmin.from("users").select("id,source_system,legacy_user_id").eq("id", t.user_id).maybeSingle();
    const { data: gAa } = await supabaseAdmin.from("auth_accounts").select("id").eq("provider", "google").eq("user_id", t.user_id);
    const { data: authDup } = await supabaseAdmin.from("user_profiles").select("user_id").ilike("auth_email", e).neq("user_id", t.user_id);
    const { data: contactDup } = await supabaseAdmin.from("user_profiles").select("user_id").ilike("contact_email", e).neq("user_id", t.user_id);
    const { data: emailAa } = await supabaseAdmin.from("auth_accounts").select("id").ilike("email", e);

    const migrated = !!((usr as any)?.source_system ?? (usr as any)?.legacy_user_id);
    const checks = {
      marker: markerSet.has(t.user_id),
      org: p?.organization_slug === ORG,
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

  const { count: usersBefore } = await supabaseAdmin.from("users").select("id", { count: "exact", head: true });
  const { count: profBefore } = await supabaseAdmin.from("user_profiles").select("user_id", { count: "exact", head: true });

  if (!APPLY) { console.log("\n(미리보기 — 적용 --apply)"); return; }

  console.log(`\n적용 시작...`);
  let ok = 0;
  for (const b of backup) {
    const { error } = await supabaseAdmin
      .from("user_profiles").update({ auth_email: b.email, contact_email: b.email }).eq("user_id", b.user_id);
    if (error) { console.log(`  ✗ ${b.name}: ${error.message}`); continue; }
    console.log(`  ✓ ${b.name}: contact_email/auth_email = ${b.email}`);
    ok++;
  }
  mkdirSync(dirname(BACKUP_PATH), { recursive: true });
  writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2), "utf8");

  const { count: usersAfter } = await supabaseAdmin.from("users").select("id", { count: "exact", head: true });
  const { count: profAfter } = await supabaseAdmin.from("user_profiles").select("user_id", { count: "exact", head: true });
  console.log(`\n✅ 적용 ${ok}/${backup.length}건 → 백업 ${BACKUP_PATH}`);
  console.log(`신규 생성 확인: users ${usersBefore}→${usersAfter}(Δ${(usersAfter ?? 0) - (usersBefore ?? 0)}) · user_profiles ${profBefore}→${profAfter}(Δ${(profAfter ?? 0) - (profBefore ?? 0)})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
