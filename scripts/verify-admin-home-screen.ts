/**
 * /admin HOME 화면 교체 브라우저 검증.
 *   1) 로그인 전 /login UI 정상 (로그인 폼 노출)
 *   2) 로그인 후 /admin → HOME 문구 표시 + 대시보드 미노출
 *   3) 사이드바 상단 텍스트 "HOME"
 *   4) HOME 에서 사이드바 메뉴 클릭 막힘 (이동 안 됨)
 *   5) 하위 페이지(/admin/members)에서는 메뉴 클릭 정상
 *   6) HOME 상단 헤더 빈 상태 (타이틀/버튼 없음), 하위 페이지에서는 헤더 정상
 *   사전조건: admin dev :3000.
 *   npx tsx scripts/verify-admin-home-screen.ts
 * READ-ONLY. 스크린샷은 claudedocs/.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookies(): Promise<Array<{ name: string; value: string }>> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
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
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    // 1) 로그인 전 /login UI
    {
      console.log("\n[1] 로그인 전 /login UI");
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      const page = await ctx.newPage();
      await page.goto(`${adminBase}/login`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      const hasForm = await page.evaluate(
        () => !!document.querySelector("input[type=email], input[type=password], form"),
      );
      check("로그인 폼 노출", hasForm);
      // 미로그인 /admin 접근 → /login 리다이렉트
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);
      check("미로그인 /admin → /login 리다이렉트", page.url().includes("/login"), page.url());
      await page.screenshot({ path: "claudedocs/home-screen-login.png" });
      await ctx.close();
    }

    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    // 2~3) /admin HOME 문구 + 사이드바 "HOME"
    {
      console.log("\n[2] 로그인 후 /admin HOME 화면");
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3000);
      const body = await page.evaluate(() => document.body.innerText);
      check("HOME 문구(BlackSmith) 표시", body.includes("BlackSmith"));
      check("HOME 문구(무럭무럭) 표시", body.includes("무럭무럭"));
      check("HOME 문구(주의!) 표시", body.includes("(주의!)"));
      check("기존 대시보드 미노출(KPI/조치 필요 없음)", !body.includes("조치 필요") && !body.includes("KPI"));
      const sidebarTop = await page.evaluate(
        () => document.querySelector("aside span")?.textContent?.trim() ?? "",
      );
      check('사이드바 상단 텍스트 "HOME"', sidebarTop === "HOME", `"${sidebarTop}"`);
      const headerText = await page.evaluate(
        () => document.querySelector("header")?.innerText?.trim() ?? "(no header)",
      );
      check("HOME 헤더 빈 상태", headerText === "", `"${headerText}"`);
      await page.screenshot({ path: "claudedocs/home-screen-admin.png", fullPage: true });
    }

    // 4) HOME 에서 메뉴 클릭 막힘
    {
      console.log("\n[3] HOME 에서 사이드바 메뉴 클릭 차단");
      // leaf 링크 (대시보드 /admin 자기 자신 외에 직접 이동 가능한 child 가 없으므로
      // 멤버 관리 branch 버튼 disabled + leaf pointer-events 확인)
      const state = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const links = [...(aside?.querySelectorAll("nav a") ?? [])].map((a) => ({
          href: a.getAttribute("href"),
          ariaDisabled: a.getAttribute("aria-disabled"),
          pe: getComputedStyle(a).pointerEvents,
        }));
        const buttons = [...(aside?.querySelectorAll("nav button") ?? [])].map((b) => ({
          title: b.getAttribute("title") ?? b.textContent?.trim(),
          disabled: (b as HTMLButtonElement).disabled,
        }));
        return { links, buttons };
      });
      check(
        "모든 nav 링크 pointer-events:none + aria-disabled",
        state.links.length > 0 &&
          state.links.every((l) => l.pe === "none" && l.ariaDisabled === "true"),
        JSON.stringify(state.links),
      );
      check(
        "모든 branch 버튼 disabled",
        state.buttons.length > 0 && state.buttons.every((b) => b.disabled),
        JSON.stringify(state.buttons),
      );
      // 강제 클릭 시도 후에도 URL 유지 (branch 버튼이 disabled 라 펼침도 안 됨)
      const before = page.url();
      await page.evaluate(() => {
        const a = document.querySelector("aside nav a") as HTMLAnchorElement | null;
        a?.click();
      });
      await page.waitForTimeout(1500);
      check("프로그램 클릭에도 URL 유지", page.url() === before, page.url());
    }

    // 5) 하위 페이지에서는 메뉴 정상
    {
      console.log("\n[4] 하위 페이지(/admin/members) 메뉴 정상 동작");
      await page.goto(`${adminBase}/admin/members`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      await page.waitForTimeout(3000);
      const state = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const link = aside?.querySelector("nav a");
        const btn = aside?.querySelector("nav button") as HTMLButtonElement | null;
        return {
          linkPe: link ? getComputedStyle(link).pointerEvents : "(none found)",
          linkDisabled: link?.getAttribute("aria-disabled"),
          btnDisabled: btn?.disabled ?? null,
        };
      });
      check("nav 링크 클릭 가능", state.linkPe !== "none" && state.linkDisabled !== "true", JSON.stringify(state));
      check("branch 버튼 enabled", state.btnDisabled === false, String(state.btnDisabled));
      const headerText = await page.evaluate(
        () => document.querySelector("header")?.innerText?.replace(/\s+/g, " ").trim() ?? "",
      );
      check("하위 페이지 헤더 정상(타이틀/버튼 노출)", headerText.length > 0, `"${headerText}"`);
      // 실제 메뉴 클릭으로 이동 확인: "멤버 관리" branch 펼친 뒤 승인 대기 클릭
      const applicantsLink = page.locator('aside nav a[href="/admin/users/applicants"]');
      if ((await applicantsLink.count()) === 0) {
        await page.locator("aside nav button", { hasText: "멤버 관리" }).first().click();
        await page.waitForTimeout(500);
      }
      await applicantsLink.first().click();
      await page.waitForTimeout(3000);
      check("메뉴 클릭으로 이동 성공", page.url().includes("/admin/users/applicants"), page.url());
      await page.screenshot({ path: "claudedocs/home-screen-subpage.png" });
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
