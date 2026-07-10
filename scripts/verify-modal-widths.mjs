/**
 * 모달 폭 SoT(modal-w-*) 브라우저 검증. 비파괴(읽기/열기만).
 *   npx tsx --env-file=.env.local scripts/verify-modal-widths.mjs
 * 도움말 모달(xl=960) + 초기화 확인 다이얼로그(sm=520) 열어 computed max-width·오버플로우·ESC 확인.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const e = (n) => { const v = process.env[n]; if (!v) throw new Error(n); return v; };

async function authCookies() {
  const url = e("NEXT_PUBLIC_SUPABASE_URL"), anonKey = e("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(url, e("SUPABASE_SERVICE_ROLE_KEY")), anon = createClient(url, anonKey);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(url, anonKey, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(i => ({ name: i.name, value: i.value }))) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map(c => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

function measurePanel(page) {
  return page.evaluate(() => {
    const p = document.querySelector('[class*="modal-w-"]');
    if (!p) return null;
    const cs = getComputedStyle(p);
    const box = p.getBoundingClientRect();
    return {
      cls: [...p.classList].find(c => c.startsWith("modal-w-")),
      maxWidth: cs.maxWidth,
      renderedWidth: Math.round(box.width),
      pageOverflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      withinViewport: box.right <= window.innerWidth + 1 && box.left >= -1,
    };
  });
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const out = {};
  try {
    for (const width of [1440, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`${baseUrl}/admin/processes/register`, { waitUntil: "networkidle" });

      // ── 도움말 모달(xl=960) ──
      await page.getByRole("button", { name: /^도움말/ }).first().click();
      await page.locator('[class*="modal-w-"]').first().waitFor({ state: "visible", timeout: 8000 });
      out[`help@${width}`] = await measurePanel(page);
      await page.screenshot({ path: `claudedocs/qa-modal-help-${width}.png` });
      // ESC 닫힘 회귀 확인
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      out[`help@${width}`].escClosed = (await page.locator('[class*="modal-w-"]').count()) === 0;

      // ── 초기화 확인 다이얼로그(sm=520, 소형 예외) — 1440에서만 ──
      if (width === 1440) {
        const hub = page.locator('select[aria-label="허브 급"]');
        const vals = await hub.locator("option").evaluateAll(o => o.map(x => x.value));
        await hub.selectOption(vals.find(x => x && x !== "-"));
        await page.waitForTimeout(400);
        await page.getByRole("button", { name: "초기화", exact: true }).first().click();
        await page.locator('[class*="modal-w-"]').first().waitFor({ state: "visible", timeout: 8000 });
        out["confirm@1440"] = await measurePanel(page);
        await page.screenshot({ path: "claudedocs/qa-modal-confirm-1440.png" });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
        out["confirm@1440"].escClosed = (await page.locator('[class*="modal-w-"]').count()) === 0;
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
