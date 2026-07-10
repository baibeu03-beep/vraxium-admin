/**
 * 활동관리 상세 헤더 조직명 검증 — /admin/team-parts/info/weeks/[weekId].
 *   SMOKE_BASE_URL=http://localhost:3100 npx tsx --env-file=.env.local scripts/verify-weekdetail-orgname.mjs
 * 3개 org × 일반/mode=test 에서 헤더 배지 텍스트·색·URL(동일 DTO 경로) 확인.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3100";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const WEEK = "640ab545-4399-44e7-99b8-d207e4092124";
const EXPECT = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
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

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const out = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    for (const org of ["encre", "oranke", "phalanx"]) {
      for (const mode of ["normal", "test"]) {
        const q = `?org=${org}${mode === "test" ? "&mode=test" : ""}`;
        await page.goto(`${baseUrl}/admin/team-parts/info/weeks/${WEEK}${q}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(300);
        const r = await page.evaluate(() => {
          const header = document.querySelector('[data-slot="card-header"]');
          const title = header?.querySelector('[data-slot="card-title"]')?.textContent?.trim();
          const badge = header?.querySelector('span.font-medium'); // OrganizationBadge
          const cs = badge ? getComputedStyle(badge) : null;
          const tBox = header?.querySelector('[data-slot="card-title"]')?.getBoundingClientRect();
          const bBox = badge?.getBoundingClientRect();
          return {
            title,
            badgeText: badge?.textContent?.trim() ?? null,
            badgeColor: cs?.color, badgeFontSize: cs?.fontSize, whiteSpace: cs?.whiteSpace,
            sameLineAsTitle: tBox && bBox ? Math.abs(tBox.top - bBox.top) < tBox.height : null,
          };
        });
        out.push({ org, mode, url: q, expected: EXPECT[org], ...r,
          ok: r.badgeText === EXPECT[org] && r.title === "활동 관리" });
      }
    }
    await page.screenshot({ path: "claudedocs/qa-weekdetail-orgname.png" });
    await ctx.close();
  } finally { await browser.close(); }
  console.log(JSON.stringify(out, null, 2));
  const parity = ["encre","oranke","phalanx"].every(o => {
    const n = out.find(x=>x.org===o&&x.mode==="normal"), t = out.find(x=>x.org===o&&x.mode==="test");
    return n && t && n.badgeText === t.badgeText;
  });
  console.log("normal/test parity:", parity);
}
main().catch(e => { console.error(e); process.exit(1); });
