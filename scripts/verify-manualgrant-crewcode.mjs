/**
 * 선별 액트·수동 부여 모달 크루코드 줄바꿈 검증. 비파괴(검색만·저장 안 함).
 *   SMOKE_BASE_URL=http://localhost:3100 npx tsx --env-file=.env.local scripts/verify-manualgrant-crewcode.mjs
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3100";
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

async function openChoicePopup(page) {
  for (const hub of ["info", "club", "competency"]) {
    await page.goto(`${baseUrl}/admin/processes/check/${hub}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    const needed = page.getByText("체크 필요", { exact: false });
    const n = await needed.count();
    for (let i = 0; i < n; i++) {
      await needed.nth(i).click().catch(() => {});
      await page.waitForTimeout(400);
      if (await page.getByRole("heading", { name: "선별 액트 체크" }).isVisible().catch(() => false)) {
        return hub;
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(200);
    }
  }
  return null;
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const out = {};
  try {
    for (const width of [1440, 1280, 1920, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      const hub = await openChoicePopup(page);
      if (!hub) { out[`w${width}`] = "no selection act reachable"; await ctx.close(); continue; }
      await page.getByRole("button", { name: /수동 부여/ }).first().click();
      const panel = page.locator('[class*="modal-w-"]').first();
      await panel.waitFor({ state: "visible", timeout: 8000 });
      // 검색 → 드롭다운 크루코드 표시
      await page.getByPlaceholder("이름으로 검색").fill("김");
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => {
        const round = (n) => Math.round(n * 10) / 10;
        const panel = document.querySelector('[class*="modal-w-"]');
        const code = panel?.querySelector('span.font-mono'); // 드롭다운 첫 크루코드
        const cs = code ? getComputedStyle(code) : null;
        const cbox = code?.getBoundingClientRect();
        const pcs = panel ? getComputedStyle(panel) : null;
        const pbox = panel?.getBoundingClientRect();
        return {
          modalMaxWidth: pcs?.maxWidth, modalWidth: pbox ? round(pbox.width) : null,
          crewCodeText: code?.textContent, crewCodeWidth: cbox ? round(cbox.width) : null,
          crewCodeHeight: cbox ? round(cbox.height) : null, crewCodeLineHeight: cs?.lineHeight,
          crewCodeWhiteSpace: cs?.whiteSpace,
          singleLine: cbox && cs ? cbox.height <= parseFloat(cs.lineHeight) * 1.4 : null,
          modalInnerScrollX: panel ? panel.scrollWidth > panel.clientWidth + 1 : null,
        };
      });
      out[`w${width}`] = m;
      await page.screenshot({ path: `claudedocs/qa-manualgrant-${width}.png` });
      await ctx.close();
    }
  } finally { await browser.close(); }
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
