/**
 * 좌측 하단 토스트 + 확대 스타일 검증 — /admin/team-parts/info/weeks/[weekId].
 *   npx tsx --env-file=.env.local scripts/verify-toast-left-bottom.mjs
 * 비파괴: open-confirm POST 목킹(DB write 없음). 1280/1440/1920 에서 computed style·사이드바 비겹침 확인.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(n) { const v = process.env[n]; if (!v) throw new Error(`Missing env: ${n}`); return v; }

async function authCookies() {
  const url = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(url, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const anon = createClient(url, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(url, anonKey, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) } });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

function toastLocator(page) {
  return page.locator('[role="status"], [role="alert"]').filter({ has: page.locator('button[aria-label="알림 닫기"]') });
}

async function triggerToast(page) {
  await page.goto(`${baseUrl}/admin/team-parts/info/weeks`, { waitUntil: "networkidle" });
  const manage = page.locator("[data-manage-activity]:not([disabled])").first();
  await manage.waitFor({ state: "visible", timeout: 15000 });
  await manage.click();
  await page.waitForURL(/\/team-parts\/info\/weeks\/[^/]+/, { timeout: 15000 });
  const openBtn = page.getByRole("button", { name: "클럽 활동 진행", exact: true });
  await openBtn.waitFor({ state: "visible", timeout: 15000 });
  await openBtn.click();
  const toasts = toastLocator(page);
  await toasts.first().waitFor({ state: "visible", timeout: 8000 });
  return toasts;
}

async function measure(page, toasts) {
  return page.evaluate(() => {
    const round = (n) => Math.round(n * 100) / 100;
    const toastEl = document.querySelector('[role="status"] , [role="alert"]');
    const container = toastEl?.parentElement;
    const closeBtn = toastEl?.querySelector('button[aria-label="알림 닫기"]');
    const aside = document.querySelector("aside");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const t = cs(toastEl), c = cs(container), b = cs(closeBtn);
    const tBox = toastEl?.getBoundingClientRect();
    const cBox = container?.getBoundingClientRect();
    const bBox = closeBtn?.getBoundingClientRect();
    const asideBox = aside?.getBoundingClientRect();
    return {
      sidebarRight: asideBox ? round(asideBox.right) : null,
      containerLeft: cBox ? round(cBox.left) : null,
      containerBottomFromViewport: cBox ? round(window.innerHeight - cBox.bottom) : null,
      containerMaxWidth: c?.maxWidth,
      noOverlapWithSidebar: asideBox && cBox ? cBox.left >= asideBox.right : null,
      withinViewport: tBox ? tBox.right <= window.innerWidth + 1 && tBox.left >= 0 : null,
      toastWidth: tBox ? round(tBox.width) : null,
      padding: t ? `${t.paddingTop} ${t.paddingRight} ${t.paddingBottom} ${t.paddingLeft}` : null,
      minHeight: t?.minHeight,
      fontSize: t?.fontSize,
      lineHeight: t?.lineHeight,
      borderRadius: t?.borderRadius,
      closeBtnSize: bBox ? `${round(bBox.width)}x${round(bBox.height)}` : null,
    };
  });
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const out = {};
  try {
    for (const width of [1280, 1440, 1920]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.route("**/open-confirm**", (r) => r.request().method() === "POST"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) })
        : r.continue());
      const toasts = await triggerToast(page);
      // 스크롤 내려도 하단 고정 보이는지.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(250);
      out[`w${width}`] = await measure(page, toasts);
      await page.screenshot({ path: `claudedocs/qa-toast-left-${width}.png` });
      await ctx.close();
    }
    // 모바일 390 — 전체 폭 유지 확인.
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.route("**/open-confirm**", (r) => r.request().method() === "POST"
        ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) })
        : r.continue());
      const toasts = await triggerToast(page);
      out.w390 = await measure(page, toasts);
      await page.screenshot({ path: "claudedocs/qa-toast-left-390.png" });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
