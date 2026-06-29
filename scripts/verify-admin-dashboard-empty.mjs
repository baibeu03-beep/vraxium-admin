// 검증 — HOME(/admin)과 대시보드(/admin/dashboard) 분리.
//   읽기 전용. 스크린샷은 claudedocs/.
//   1) 미로그인 /admin → /login 리다이렉트(기존 동작)
//   2) 로그인 직후 /admin: 기존 HOME 화면 그대로(안내문/HomeLaunchGrid 노출)
//   3) HOME에서 '대시보드' 메뉴 클릭 → /admin/dashboard 이동(navLocked 예외) + 본문 빈 화면
//   4) /admin/dashboard: 본문(main) 비어 있음 + 사이드바/헤더 유지 + 다른 메뉴 클릭 가능
//   5) 하위 페이지에서 HOME 버튼 클릭 → /admin HOME 화면 복귀
//   사전조건: admin dev :3000.  실행: node scripts/verify-admin-dashboard-empty.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    // 1) 미로그인 /admin → /login
    {
      console.log("\n[1] 미로그인 /admin 접근");
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      check("미로그인 /admin → /login 리다이렉트", page.url().includes("/login"), page.url());
      await ctx.close();
    }

    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    // 2) 로그인 직후 /admin = 기존 HOME 화면
    {
      console.log("\n[2] 로그인 직후 /admin = 기존 HOME 화면");
      await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      const mainText = await page.evaluate(
        () => document.querySelector("main")?.innerText ?? "",
      );
      check("HOME 안내문(BlackSmith) 노출", mainText.includes("BlackSmith"));
      check("HOME 안내문(무럭무럭) 노출", mainText.includes("무럭무럭"));
      check("HOME 안내문(주의!) 노출", mainText.includes("(주의!)"));
      await page.screenshot({ path: "claudedocs/admin-home-restored.png", fullPage: true });
    }

    // 3) HOME에서 '대시보드' 메뉴 클릭 → /admin/dashboard (navLocked 예외)
    {
      console.log("\n[3] HOME에서 '대시보드' 클릭 → /admin/dashboard");
      const dashLink = page.locator('aside nav a[href="/admin/dashboard"]');
      check("대시보드 메뉴 링크(href=/admin/dashboard) 존재", (await dashLink.count()) > 0);
      const lockState = await page.evaluate(() => {
        const a = document.querySelector('aside nav a[href="/admin/dashboard"]');
        return a
          ? { pe: getComputedStyle(a).pointerEvents, ariaDisabled: a.getAttribute("aria-disabled") }
          : null;
      });
      check(
        "HOME에서 대시보드 메뉴 클릭 가능(navLocked 예외)",
        !!lockState && lockState.pe !== "none" && lockState.ariaDisabled !== "true",
        JSON.stringify(lockState),
      );
      await dashLink.first().click();
      await page.waitForTimeout(3000);
      check("대시보드 클릭 → /admin/dashboard 이동", page.url().includes("/admin/dashboard"), page.url());
    }

    // 4) /admin/dashboard = 본문 빈 화면 + 네비 유지 + 다른 메뉴 클릭 가능
    {
      console.log("\n[4] /admin/dashboard 본문 빈 화면 + 네비 유지");
      const state = await page.evaluate(() => {
        const main = document.querySelector("main");
        const mainText = (main?.innerText ?? "").trim();
        const otherLink = [...document.querySelectorAll("aside nav a")].find(
          (a) => (a.getAttribute("href") ?? "") !== "/admin/dashboard",
        );
        return {
          mainText,
          hasSidebar: !!document.querySelector("aside"),
          navLinkCount: document.querySelectorAll("aside nav a").length,
          hasHeader: !!document.querySelector("header"),
          otherPe: otherLink ? getComputedStyle(otherLink).pointerEvents : "(none)",
          otherDisabled: otherLink?.getAttribute("aria-disabled") ?? null,
        };
      });
      check("본문(main) 비어 있음", state.mainText === "", `"${state.mainText.slice(0, 60)}"`);
      check("기존 HOME 안내문 미노출", !state.mainText.includes("BlackSmith"));
      check("사이드바 유지", state.hasSidebar);
      check("사이드바 메뉴 링크 존재", state.navLinkCount > 0, `links=${state.navLinkCount}`);
      check("상단 헤더 유지", state.hasHeader);
      check(
        "다른 메뉴 클릭 가능(navLocked 아님)",
        state.otherPe !== "none" && state.otherDisabled !== "true",
        JSON.stringify({ pe: state.otherPe, disabled: state.otherDisabled }),
      );
      await page.screenshot({ path: "claudedocs/admin-dashboard-empty.png", fullPage: true });
    }

    // 5) 하위 페이지에서 HOME 버튼 클릭 → /admin HOME 복귀
    {
      console.log("\n[5] 하위 페이지에서 HOME 버튼 → /admin 복귀");
      await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
      const homeLink = page.locator('aside a', { hasText: "HOME" }).first();
      check("HOME 버튼 존재", (await homeLink.count()) > 0);
      await homeLink.click();
      await page.waitForTimeout(3000);
      const mainText = await page.evaluate(() => document.querySelector("main")?.innerText ?? "");
      const onHome = new URL(page.url()).pathname === "/admin";
      check("HOME 버튼 클릭 → /admin 이동", onHome, page.url());
      check("HOME 화면(BlackSmith) 표시", mainText.includes("BlackSmith"));
      await page.screenshot({ path: "claudedocs/admin-home-via-button.png" });
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
