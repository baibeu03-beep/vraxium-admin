/**
 * 사이드바 관리자 정보 표시 + 로그아웃 + 비밀번호 재설정 화면 브라우저 검증 (Playwright).
 *   - /admin(HOME) · /admin/members(일반 페이지)에서 이름/환영문구/이메일 표시
 *   - 사이드바 접힘 상태에서 이니셜 배지 표시
 *   - 로그아웃 버튼 → /login 이동
 *   - /forgot-password 폼 렌더, /reset-password 무세션 안내
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/verify-sidebar-admin-info-browser.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

// playwright 는 admin repo 에 미설치 — 인접 고객 repo(../vraxium) 설치본을 재사용.
const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
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
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const context = await browser.newContext({ baseURL: baseUrl });
  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    // ── 1) HOME(/admin) — navLocked 상태에서도 정보 표시 ───────────────
    await page.goto("/admin", { waitUntil: "networkidle" });
    const sidebar = page.locator("aside");
    check(
      "HOME: 이름 표시 (vanuatu.golden님)",
      await sidebar.getByText("vanuatu.golden님").isVisible(),
    );
    check("HOME: 환영 문구", await sidebar.getByText("환영합니다 😊").isVisible());
    check(
      "HOME: 이메일 표시",
      await sidebar.getByText(adminEmail).isVisible(),
    );
    await page.screenshot({ path: "scripts/_sidebar-home.png" });

    // ── 2) 일반 페이지(/admin/members) ─────────────────────────────────
    await page.goto("/admin/members", { waitUntil: "networkidle" });
    check(
      "일반 페이지: 이름 표시",
      await sidebar.getByText("vanuatu.golden님").isVisible(),
    );
    check(
      "일반 페이지: 이메일 표시",
      await sidebar.getByText(adminEmail).isVisible(),
    );

    // ── 3) 사이드바 접힘 — 이니셜 배지 ─────────────────────────────────
    await page.getByRole("button", { name: "사이드바 접기" }).click();
    const badge = sidebar.locator('[aria-label="로그인된 관리자 정보"]');
    check("접힘: 이니셜 배지 표시", await badge.isVisible());
    check(
      "접힘: 이니셜 = 이름 첫 글자(v)",
      (await badge.innerText()).trim() === "v",
      `text=${(await badge.innerText()).trim()}`,
    );
    check(
      "접힘: 이름/이메일 텍스트 숨김",
      !(await sidebar.getByText("vanuatu.golden님").isVisible()),
    );
    await page.screenshot({ path: "scripts/_sidebar-collapsed.png" });
    await page.getByRole("button", { name: "사이드바 펴기" }).click();

    // ── 4) 비밀번호 재설정 화면들 ──────────────────────────────────────
    const anonPage = await (await browser.newContext({ baseURL: baseUrl })).newPage();
    await anonPage.goto("/forgot-password", { waitUntil: "networkidle" });
    check(
      "/forgot-password: 폼 렌더",
      await anonPage.getByRole("button", { name: "재설정 메일 보내기" }).isVisible(),
    );
    await anonPage.goto("/reset-password", { waitUntil: "networkidle" });
    check(
      "/reset-password: 무세션 안내",
      await anonPage
        .getByText("재설정 세션이 없거나 만료되었습니다", { exact: false })
        .isVisible(),
    );
    await anonPage.goto("/login", { waitUntil: "networkidle" });
    check(
      "/login: 비밀번호를 잊으셨나요? 링크",
      await anonPage.getByText("비밀번호를 잊으셨나요?").isVisible(),
    );
    await anonPage.context().close();

    // ── 5) 로그아웃 (마지막 — 세션 무효화) ─────────────────────────────
    await page.goto("/admin", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "로그아웃" }).click();
    await page.waitForURL("**/login", { timeout: 15000 });
    check("로그아웃 → /login 이동", page.url().includes("/login"), page.url());
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
