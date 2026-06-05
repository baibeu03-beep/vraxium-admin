/**
 * 관리자 이름(display_name) 조회 + 비밀번호 재설정 플로우 검증.
 *   1) direct(service-role 직접 조회) vs HTTP GET /api/admin/me 동일성
 *   2) /api/admin/me 비로그인 401
 *   3) POST /api/auth/password-reset/request — 관리자/비관리자/형식오류 응답
 *   4) GET /auth/recovery — code 없음 → /forgot-password?error=missing_code 리다이렉트
 *   5) POST /api/auth/password-reset/complete — 무세션 401 / 짧은 비번 400 /
 *      일회용 테스트 유저의 recovery 세션으로 실제 변경 → 새 비번 로그인 확인 → 유저 삭제
 *
 *   사전조건: dev 서버 (기본 http://localhost:3000, SMOKE_BASE_URL 로 변경).
 *   npx tsx --env-file=.env.local scripts/verify-admin-name-and-password-reset.ts
 *   (SEND_REAL_RESET_MAIL=1 일 때만 실제 관리자 메일로 재설정 메일을 발송한다)
 */
import { createClient, type Session } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const sendRealMail = process.env.SEND_REAL_RESET_MAIL === "1";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(supabaseUrl, serviceRoleKey);

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function sessionToCookieHeader(session: Session) {
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error } = await server.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function makeAdminCookieHeader() {
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  return sessionToCookieHeader(verifyData.session);
}

async function main() {
  // ── 1) direct vs HTTP /api/admin/me ─────────────────────────────────
  const { data: adminRow, error: adminError } = await admin
    .from("admin_users")
    .select("id,email,role,is_active")
    .eq("email", adminEmail)
    .maybeSingle();
  if (adminError || !adminRow) throw new Error(adminError?.message ?? "admin row missing");

  const { data: profileRow } = await admin
    .from("user_profiles")
    .select("display_name")
    .eq("user_id", adminRow.id)
    .maybeSingle();
  const directDisplayName =
    (profileRow?.display_name ?? "").trim().length > 0
      ? (profileRow!.display_name as string).trim()
      : null;
  console.log(
    `direct | userId=${adminRow.id} email=${adminRow.email} role=${adminRow.role} ` +
      `isActive=${adminRow.is_active} displayName=${directDisplayName}`,
  );

  const cookieHeader = await makeAdminCookieHeader();
  const meRes = await fetch(`${baseUrl}/api/admin/me`, {
    headers: { Cookie: cookieHeader },
  });
  const meJson = (await meRes.json()) as {
    success?: boolean;
    data?: {
      userId: string;
      email: string | null;
      role: string;
      isActive: boolean;
      displayName: string | null;
    };
  };
  check("GET /api/admin/me 200 success", meRes.status === 200 && meJson.success === true);
  const me = meJson.data;
  console.log(`http   | ${JSON.stringify(me)}`);
  check("me.userId == direct", me?.userId === adminRow.id);
  check("me.email == direct", me?.email === adminRow.email);
  check("me.role == direct", me?.role === adminRow.role);
  check("me.isActive == direct", me?.isActive === Boolean(adminRow.is_active));
  check(
    "me.displayName == direct(user_profiles.display_name)",
    me?.displayName === directDisplayName,
    `http=${me?.displayName} direct=${directDisplayName}`,
  );

  // ── 2) 비로그인 401 ─────────────────────────────────────────────────
  const noAuthRes = await fetch(`${baseUrl}/api/admin/me`);
  check("GET /api/admin/me (no cookie) → 401", noAuthRes.status === 401, `status=${noAuthRes.status}`);

  // ── 3) password-reset/request ───────────────────────────────────────
  if (sendRealMail) {
    const reqRes = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail }),
    });
    const reqJson = (await reqRes.json()) as { success?: boolean };
    check(
      "request(관리자 이메일) → 200 success (실제 메일 발송됨)",
      reqRes.status === 200 && reqJson.success === true,
      `status=${reqRes.status}`,
    );
  } else {
    console.log("skip | 관리자 이메일 실제 발송 (SEND_REAL_RESET_MAIL=1 로 활성화)");
  }

  const nonAdminRes = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "definitely-not-an-admin-xyz@example.com" }),
  });
  const nonAdminJson = (await nonAdminRes.json()) as { success?: boolean };
  check(
    "request(비관리자 이메일) → 200 generic success (발송 안 함·enumeration 방지)",
    nonAdminRes.status === 200 && nonAdminJson.success === true,
    `status=${nonAdminRes.status}`,
  );

  const badEmailRes = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "not-an-email" }),
  });
  check("request(형식 오류) → 400", badEmailRes.status === 400, `status=${badEmailRes.status}`);

  // ── 4) /auth/recovery code 없음 → /forgot-password 리다이렉트 ───────
  const recoveryRes = await fetch(`${baseUrl}/auth/recovery`, { redirect: "manual" });
  const location = recoveryRes.headers.get("location") ?? "";
  check(
    "GET /auth/recovery (code 없음) → /forgot-password?error=missing_code",
    [301, 302, 303, 307, 308].includes(recoveryRes.status) &&
      location.includes("/forgot-password") &&
      location.includes("error=missing_code"),
    `status=${recoveryRes.status} location=${location}`,
  );

  // ── 5) password-reset/complete ──────────────────────────────────────
  const noSessionRes = await fetch(`${baseUrl}/api/auth/password-reset/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "Whatever-123456" }),
  });
  check("complete(무세션) → 401", noSessionRes.status === 401, `status=${noSessionRes.status}`);

  // 일회용 테스트 유저로 실제 recovery 세션 → 비밀번호 변경 검증.
  const testEmail = `pwreset-verify-${Date.now()}@example.com`;
  const oldPassword = `Old-${Date.now()}-pw!`;
  const newPassword = `New-${Date.now()}-pw!`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: testEmail,
    password: oldPassword,
    email_confirm: true,
  });
  if (createError || !created.user) throw new Error(createError?.message ?? "createUser failed");
  const testUserId = created.user.id;

  try {
    const { data: recLink, error: recError } = await admin.auth.admin.generateLink({
      type: "recovery",
      email: testEmail,
    });
    if (recError || !recLink?.properties?.email_otp) {
      throw new Error(recError?.message ?? "recovery link failed");
    }
    const browser = createClient(supabaseUrl, anonKey);
    const { data: recVerify, error: recVerifyError } = await browser.auth.verifyOtp({
      email: testEmail,
      token: recLink.properties.email_otp,
      type: "recovery",
    });
    if (recVerifyError || !recVerify.session) {
      throw new Error(recVerifyError?.message ?? "recovery verifyOtp failed");
    }
    const recoveryCookie = await sessionToCookieHeader(recVerify.session);

    const shortRes = await fetch(`${baseUrl}/api/auth/password-reset/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: recoveryCookie },
      body: JSON.stringify({ password: "short" }),
    });
    check("complete(8자 미만) → 400", shortRes.status === 400, `status=${shortRes.status}`);

    const completeRes = await fetch(`${baseUrl}/api/auth/password-reset/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: recoveryCookie },
      body: JSON.stringify({ password: newPassword }),
    });
    const completeJson = (await completeRes.json()) as { success?: boolean; error?: string };
    check(
      "complete(recovery 세션) → 200 success",
      completeRes.status === 200 && completeJson.success === true,
      `status=${completeRes.status} error=${completeJson.error ?? ""}`,
    );

    const signinNew = createClient(supabaseUrl, anonKey);
    const { data: newLogin, error: newLoginError } = await signinNew.auth.signInWithPassword({
      email: testEmail,
      password: newPassword,
    });
    check("새 비밀번호로 로그인 성공", !newLoginError && Boolean(newLogin.session));

    const signinOld = createClient(supabaseUrl, anonKey);
    const { error: oldLoginError } = await signinOld.auth.signInWithPassword({
      email: testEmail,
      password: oldPassword,
    });
    check("기존 비밀번호 로그인 실패(무효화 확인)", Boolean(oldLoginError));
  } finally {
    const { error: deleteError } = await admin.auth.admin.deleteUser(testUserId);
    console.log(
      deleteError
        ? `WARN | 테스트 유저 삭제 실패: ${deleteError.message} (${testUserId})`
        : `info | 테스트 유저 삭제 완료 (${testEmail})`,
    );
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
