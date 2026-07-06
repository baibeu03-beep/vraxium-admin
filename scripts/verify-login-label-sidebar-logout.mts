/**
 * 1) 로그인 화면 "Admin Code" 라벨 + Email 문구 부재
 * 2) 사이드바 하단 로그아웃 버튼 — 긴 페이지(/admin/members 등) 스크롤 후에도
 *    뷰포트 안에 항상 보이는지 (sticky+h-screen 수정 검증)
 * 3) 다른 어드민 화면 이동 시에도 유지
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/verify-login-label-sidebar-logout.mts
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
const VIEWPORT = { width: 1280, height: 720 };

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

type Page = import("playwright").Page;

/** 로그아웃 버튼이 "현재 뷰포트 안"에 실제로 보이는지 (visible 만으론 문서 하단도 true). */
async function logoutInViewport(page: Page) {
  const btn = page.getByRole("button", { name: "로그아웃" });
  if (!(await btn.isVisible())) return { ok: false, detail: "not visible" };
  const box = await btn.boundingBox();
  if (!box) return { ok: false, detail: "no boundingBox" };
  const ok = box.y >= 0 && box.y + box.height <= VIEWPORT.height;
  return { ok, detail: `y=${Math.round(box.y)} h=${Math.round(box.height)}` };
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ channel: "chromium" });

  try {
    // ── 1) 로그인 화면(비로그인): Admin Code 라벨 ───────────────────────
    const anonCtx = await browser.newContext({ baseURL: baseUrl, viewport: VIEWPORT });
    const anonPage = await anonCtx.newPage();
    await anonPage.goto("/login", { waitUntil: "networkidle" });
    check(
      "/login: 'Admin Code' 라벨 표시",
      await anonPage.getByText("Admin Code", { exact: true }).isVisible(),
    );
    const bodyText = await anonPage.locator("body").innerText();
    check(
      "/login: 사용자 노출 'Email' 문구 없음",
      !/\bEmail\b/i.test(bodyText),
      bodyText.match(/.{0,20}Email.{0,20}/i)?.[0],
    );
    await anonPage.screenshot({ path: "claudedocs/browser-login-cluv-code.png" });
    await anonCtx.close();

    // ── 2) 로그인 세션: 통합 검수 시스템(/admin/members) ───────────────
    const ctx = await browser.newContext({ baseURL: baseUrl, viewport: VIEWPORT });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    await page.goto("/admin", { waitUntil: "networkidle" });
    {
      const r = await logoutInViewport(page);
      check("HOME(/admin): 로그아웃 버튼 뷰포트 내", r.ok, r.detail);
    }

    await page.goto("/admin/members", { waitUntil: "networkidle" });
    {
      const r = await logoutInViewport(page);
      check("통합 검수(/admin/members) 진입 직후: 로그아웃 뷰포트 내", r.ok, r.detail);
    }
    // 핵심 재현 조건: 본문이 길어 문서 스크롤이 생긴 상태에서 최하단까지 스크롤.
    const scrollInfo = await page.evaluate(
      "(() => { window.scrollTo(0, document.documentElement.scrollHeight); return { scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight }; })()",
    ) as { scrollHeight: number; innerHeight: number };
    check(
      "통합 검수: 문서 스크롤 존재(재현 조건 성립)",
      scrollInfo.scrollHeight > scrollInfo.innerHeight,
      `scrollHeight=${scrollInfo.scrollHeight} viewport=${scrollInfo.innerHeight}`,
    );
    {
      const r = await logoutInViewport(page);
      check("통합 검수 최하단 스크롤 후: 로그아웃 뷰포트 내", r.ok, r.detail);
    }
    await page.evaluate("window.scrollTo(0, Math.floor(document.documentElement.scrollHeight / 2))");
    {
      const r = await logoutInViewport(page);
      check("통합 검수 중간 스크롤: 로그아웃 뷰포트 내", r.ok, r.detail);
    }
    await page.screenshot({ path: "claudedocs/browser-sidebar-logout-members-scrolled.png" });

    // ── 3) 다른 어드민 화면 이동 ───────────────────────────────────────
    for (const path of ["/admin/import", "/admin/users/applicants", "/admin/test-users"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      await page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
      const r = await logoutInViewport(page);
      check(`${path}: 최하단 스크롤 후 로그아웃 뷰포트 내`, r.ok, r.detail);
    }

    // ── 4) 로그아웃 동작 (마지막 — 세션 무효화) ────────────────────────
    await page.goto("/admin", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "로그아웃" }).click();
    await page.waitForURL("**/login", { timeout: 15000 });
    check("로그아웃 → /login 이동", page.url().includes("/login"), page.url());
    await ctx.close();
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
