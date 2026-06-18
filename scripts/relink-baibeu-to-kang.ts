import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";

const EMAIL = "baibeu03@gmail.com";
const IVE = "e2e65fb6-6b56-4ae3-a1d7-16d6e894c308"; // 김이브 (delete)
const KANG = "3330f4c3-5331-4632-bbe6-01a19017a089"; // T강서현 (target)
const AUTH_ACCOUNT_ID = "f5c8e09b-be8a-4fe2-8cd3-ace07c02fbf7";
const APPLICANT_ID = "fc76976e-0bcb-47bc-991e-29984a66b35a";

function die(msg: string): never {
  console.error("❌ ABORT:", msg);
  process.exit(1);
}

async function one(table: string, col: string, val: string) {
  const { data, error } = await supabaseAdmin.from(table).select("*").eq(col, val);
  if (error) die(`${table} read: ${error.message}`);
  return data ?? [];
}

async function main() {
  // ===== 0. BACKUP =====
  const backup: Record<string, unknown> = {
    ive_profile: await one("user_profiles", "user_id", IVE),
    ive_users: await one("users", "id", IVE),
    ive_snapshot: await one("cluster4_weekly_card_snapshots", "user_id", IVE),
    ive_season: await one("user_season_histories", "user_id", IVE),
    ive_roster: await one("cluster4_roster_card_stats", "user_id", IVE),
    kang_profile_before: await one("user_profiles", "user_id", KANG),
    auth_account_before: await one("auth_accounts", "id", AUTH_ACCOUNT_ID),
    applicant_before: await one("applicants", "id", APPLICANT_ID),
  };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `claudedocs/relink-baibeu-backup-${ts}.json`;
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`💾 backup → ${backupPath}`);

  // ===== 1. PREFLIGHT GUARDS (re-verify before any mutation) =====
  const iveProfile = (backup.ive_profile as any[])[0];
  if (!iveProfile) die("김이브 user_profiles row not found");
  if (iveProfile.display_name !== "김이브") die(`IVE name mismatch: ${iveProfile.display_name}`);
  if (iveProfile.auth_email !== EMAIL) die(`IVE auth_email != ${EMAIL}: ${iveProfile.auth_email}`);

  const authAcct = (backup.auth_account_before as any[])[0];
  if (!authAcct) die("auth_accounts row not found");
  if (authAcct.email !== EMAIL) die(`auth_account email mismatch: ${authAcct.email}`);
  if (authAcct.user_id !== IVE) die(`auth_account.user_id != IVE: ${authAcct.user_id}`);

  const applicant = (backup.applicant_before as any[])[0];
  if (!applicant) die("applicant row not found");
  if (applicant.linked_user_id !== IVE) die(`applicant.linked_user_id != IVE: ${applicant.linked_user_id}`);

  const kangProfile = (backup.kang_profile_before as any[])[0];
  if (!kangProfile) die("T강서현 user_profiles row not found");
  if (kangProfile.display_name !== "T강서현") die(`KANG name mismatch: ${kangProfile.display_name}`);

  // T강서현 must NOT already be linked to any auth account / applicant
  const kangAuth = await one("auth_accounts", "user_id", KANG);
  if (kangAuth.length > 0) die(`T강서현 already linked to auth_accounts: ${JSON.stringify(kangAuth)}`);
  const kangAppl = await one("applicants", "linked_user_id", KANG);
  if (kangAppl.length > 0) die(`T강서현 already linked to applicants: ${JSON.stringify(kangAppl)}`);

  // exactly one profile holds the email (김이브) — guards the UNIQUE + front auto-link "exactly 1" rule
  const emailHolders = await one("user_profiles", "auth_email", EMAIL);
  if (emailHolders.length !== 1 || emailHolders[0].user_id !== IVE)
    die(`unexpected auth_email holders: ${JSON.stringify(emailHolders)}`);

  console.log("✅ all preflight guards passed");

  // ===== 2. MUTATE =====
  const upd = async (table: string, patch: object, col: string, val: string) => {
    const { error } = await supabaseAdmin.from(table).update(patch).eq(col, val);
    if (error) die(`${table} update: ${error.message}`);
    console.log(`  ↻ ${table}.${col}=${val} ←`, JSON.stringify(patch));
  };
  const del = async (table: string, col: string, val: string) => {
    const { error } = await supabaseAdmin.from(table).delete().eq(col, val);
    if (error) die(`${table} delete: ${error.message}`);
    console.log(`  ✗ deleted ${table}.${col}=${val}`);
  };

  // 2a. repoint Google SoT + approval record to T강서현
  await upd("applicants", { linked_user_id: KANG }, "id", APPLICANT_ID);
  await upd("auth_accounts", { user_id: KANG, updated_at: new Date().toISOString() }, "id", AUTH_ACCOUNT_ID);

  // 2b. delete 김이브 child rows, then profile, then users row
  await del("cluster4_weekly_card_snapshots", "user_id", IVE);
  await del("user_season_histories", "user_id", IVE);
  await del("cluster4_roster_card_stats", "user_id", IVE);
  await del("user_profiles", "user_id", IVE);
  await del("users", "id", IVE);

  // 2c. set T강서현 emails (auth_email freed by IVE delete) → admin resolveProfileUserId match
  await upd(
    "user_profiles",
    { auth_email: EMAIL, contact_email: EMAIL },
    "user_id",
    KANG,
  );

  console.log("✅ mutations applied");

  // ===== 3. VERIFY (data + resolver fn the HTTP routes call) =====
  console.log("\n=== VERIFY ===");
  const iveGone = await one("user_profiles", "user_id", IVE);
  console.log(`김이브 user_profiles gone: ${iveGone.length === 0}`);
  const iveUsersGone = await one("users", "id", IVE);
  console.log(`김이브 users gone: ${iveUsersGone.length === 0}`);

  const aa = (await one("auth_accounts", "id", AUTH_ACCOUNT_ID))[0];
  console.log(`auth_accounts.user_id → KANG: ${aa.user_id === KANG} (${aa.user_id})`);
  const ap = (await one("applicants", "id", APPLICANT_ID))[0];
  console.log(`applicants.linked_user_id → KANG: ${ap.linked_user_id === KANG}`);

  const kang = (await one("user_profiles", "user_id", KANG))[0];
  console.log(`T강서현 auth_email: ${kang.auth_email} · contact_email: ${kang.contact_email}`);

  // admin HTTP route resolution (exact fn weekly-cards calls)
  const resolved = await resolveProfileUserId("00000000-0000-0000-0000-000000000000", EMAIL);
  console.log(`resolveProfileUserId(_, ${EMAIL}) → ${resolved} === KANG? ${resolved === KANG}`);

  // front getProfileById equivalent: auth_accounts.user_id → profile
  const frontProfile = (await one("user_profiles", "user_id", aa.user_id))[0];
  console.log(`front resolve (auth_accounts.user_id → profile): ${frontProfile?.display_name}`);

  // snapshot stale check (unchanged — user_id same, only email changed)
  const snap = (await one("cluster4_weekly_card_snapshots", "user_id", KANG))[0];
  console.log(
    `T강서현 snapshot: card_count=${snap.card_count} is_stale=${snap.is_stale} dto_version=${snap.dto_version}`,
  );

  console.log("\n✅ DONE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
