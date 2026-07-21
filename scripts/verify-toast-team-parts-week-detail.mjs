/**
 * 하단 고정 토스트 검증 — /admin/team-parts/info/weeks/[weekId] (주차 "활동 관리" 상세).
 *   npx tsx --env-file=.env.local scripts/verify-toast-team-parts-week-detail.mjs
 *
 * 비파괴: 오픈 확인 POST 를 page.route 로 성공 위조 → DB write 없이 "오픈 설정이 저장되었습니다."
 * 토스트만 띄운다. 상단 인라인 배너가 사라지고 하단 고정 토스트로 뜨는지 확인.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function authCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

function toastLocator(page) {
  return page.locator('[role="status"], [role="alert"]').filter({ has: page.locator('button[aria-label="알림 닫기"]') });
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const results = {};
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // 오픈 확인 POST 를 성공으로 위조 → 서버/DB 미접촉.
    await page.route("**/open-confirm**", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) })
        : route.continue(),
    );

    await page.goto(`${baseUrl}/admin/team-parts/info/weeks`, { waitUntil: "networkidle" });
    // 공식 활동(활성) "활동 관리" 버튼 클릭.
    const manage = page.locator("[data-manage-activity]:not([disabled])").first();
    await manage.waitFor({ state: "visible", timeout: 15000 });
    results.weekId = await manage.getAttribute("data-manage-activity");
    await manage.click();

    // 상세 로드 대기: "활동 관리" 헤딩 + "클럽 활동 진행" 버튼(구 "오픈 확인").
    await page.waitForURL(/\/team-parts\/info\/weeks\/[^/]+/, { timeout: 15000 });
    const openBtn = page.getByRole("button", { name: "클럽 활동 진행", exact: true });
    await openBtn.waitFor({ state: "visible", timeout: 15000 });

    await openBtn.click();

    // 토스트 대기.
    const toasts = toastLocator(page);
    await toasts.first().waitFor({ state: "visible", timeout: 8000 });
    const text = await toasts.first().innerText();

    // 상단 카드 안에 인라인 emerald 배너가 남아있지 않은지(문서 흐름 배너 제거 확인).
    const inlineOldBanner = await page
      .locator('.bg-emerald-50:has-text("오픈 설정이 저장되었습니다")')
      .count();

    // 스크롤을 하단까지 내려도 토스트가 뷰포트 하단에 고정되어 보이는지.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const scrollY = await page.evaluate(() => window.scrollY);
    const box = await toasts.first().boundingBox();
    const inViewportBottom = box && box.y + box.height <= 900 + 2 && box.y > 450;
    await page.screenshot({ path: "claudedocs/qa-toast-weekdetail-scrolled-1440.png" });

    results.toastText = text;
    results.toastHasMessage = text.includes("오픈 설정이 저장되었습니다");
    results.oldInlineBannerCount = inlineOldBanner;
    results.scrolledDown = scrollY > 50;
    results.inViewportBottom = !!inViewportBottom;

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
