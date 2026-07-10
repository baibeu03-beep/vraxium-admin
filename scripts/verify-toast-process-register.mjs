/**
 * 하단 고정 토스트(ToastViewport) 브라우저 검증 — /admin/processes/register.
 *   npx tsx --env-file=.env.local scripts/verify-toast-process-register.mjs
 *   (또는 node --env-file=.env.local ...)
 *
 * READ-ONLY 지향:
 *   - 위치/스택/닫기: 실제 "검증 실패" 에러 토스트만 사용(서버 write 없음).
 *   - 긴 문구 줄바꿈: 라인급 등록 POST 를 page.route 로 목킹(성공 응답 위조) →
 *     DB 에 아무 것도 쓰지 않고 긴/특수문자 성공 토스트만 띄운다.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const LONG = "라인급-초장문-특수문자 ~!@#**ㄹㄿㄹ_abcdefghij_가나다라마바사아자차카타파하_0123456789_끝없이길게이어지는이름테스트문자열";

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
  // ToastViewport 의 토스트: role=status|alert + 닫기 버튼(aria-label="알림 닫기") 포함.
  return page.locator('[role="status"], [role="alert"]').filter({ has: page.locator('button[aria-label="알림 닫기"]') });
}

async function selectFirstHub(page) {
  const hub = page.locator('select[aria-label="허브 급"]');
  const values = await hub.locator("option").evaluateAll((opts) => opts.map((o) => o.value));
  const real = values.find((v) => v && v !== "-");
  if (!real) throw new Error("no real hub option");
  await hub.selectOption(real);
  await page.waitForTimeout(600); // loadGroups
  return real;
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const results = [];
  try {
    // ── 1440 데스크톱: 위치 + 스택 + 닫기 ──
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/admin/processes/register`, { waitUntil: "networkidle" });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const scrollBefore = await page.evaluate(() => window.scrollY);

      await selectFirstHub(page);
      // 두 개의 서로 다른 검증 에러 토스트로 스택 확인.
      await page.getByRole("button", { name: "등록", exact: true }).last().click(); // 액트 등록(빈 액트명)
      await page.waitForTimeout(150);
      await page.getByRole("button", { name: "등록", exact: true }).first().click(); // 라인급 등록(빈 이름)
      await page.waitForTimeout(300);

      const toasts = toastLocator(page);
      const count = await toasts.count();
      const scrollAfter = await page.evaluate(() => window.scrollY);
      // 토스트가 뷰포트 하단에 있는지(첫 토스트 박스 기준).
      const box = await toasts.first().boundingBox();
      const vh = 900;
      const inViewportBottom = box && box.y + box.height <= vh + 2 && box.y > vh / 2;
      await page.screenshot({ path: "claudedocs/qa-toast-stack-1440.png" });
      results.push({ test: "stack@1440", toastCount: count, scrollPreserved: scrollAfter > 0 && Math.abs(scrollAfter - scrollBefore) < 5, inViewportBottom: !!inViewportBottom });

      // 닫기: X 하나 클릭 → 개수 감소.
      const beforeClose = await toasts.count();
      await toasts.first().locator('button[aria-label="알림 닫기"]').click();
      await page.waitForTimeout(200);
      const afterClose = await toasts.count();
      results.push({ test: "close@1440", before: beforeClose, after: afterClose, decreased: afterClose === beforeClose - 1 });
      await ctx.close();
    }

    // ── 긴 문구 줄바꿈(성공 토스트, POST 목킹으로 DB write 없음): 1440 & 390 ──
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 780 : 900 } });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      // 라인급 등록 POST 를 성공으로 위조 → 서버/DB 미접촉.
      await page.route("**/api/admin/processes/line-groups", (route) => {
        if (route.request().method() === "POST") {
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, data: { id: "mock", name: LONG } }) });
        }
        return route.continue();
      });
      await page.goto(`${baseUrl}/admin/processes/register`, { waitUntil: "networkidle" });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await selectFirstHub(page);
      await page.getByPlaceholder(/라인급명/).fill(LONG);
      await page.getByRole("button", { name: "등록", exact: true }).first().click();
      // 확인 다이얼로그(CONFIRM.save) → Enter 로 확인.
      await page.waitForTimeout(200);
      await page.keyboard.press("Enter");
      // 성공 토스트 대기.
      const toasts = toastLocator(page);
      await toasts.first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      const box = await toasts.first().boundingBox();
      const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      const text = await toasts.first().innerText().catch(() => "");
      await page.screenshot({ path: `claudedocs/qa-toast-longtext-${width}.png` });
      results.push({ test: `longtext@${width}`, hasLongText: text.includes("~!@#"), boxWidth: box ? Math.round(box.width) : null, pageOverflowX: overflowsX });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
