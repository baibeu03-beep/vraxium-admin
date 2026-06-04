/**
 * 주차 SoT 통일 브라우저 표시 검증 — T윤서진.
 *   A) 어드민 /admin/crews/encre 테이블 행 → 누적 주차/승인 주차 (구 29주 표면)
 *   B) 고객 /cluster-4?demoUserId= → medal-week-num + 이력서 시즌 행 (구 봄 2주 표면)
 *   사전조건: admin dev :3000, customer dev :3001.
 *   npx tsx scripts/verify-week-sot-browser.ts
 * READ-ONLY. 스크린샷은 claudedocs/.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const customerBase = process.env.CUSTOMER_URL ?? "http://localhost:3001";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const TARGET_UID = "76a42307-f3b2-4c08-92ab-f339a20b7d38"; // T윤서진

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

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1200 } });
    await ctx.addCookies(
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: "localhost",
        path: "/",
      })),
    );

    // A) 어드민 crews 테이블
    const page = await ctx.newPage();
    await page.goto(`${adminBase}/admin/crews/encre`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(10000);
    const row = await page.evaluate(`(() => {
      const trs = Array.from(document.querySelectorAll('tr'));
      const tr = trs.find((r) => (r.textContent || '').includes('윤서진'));
      if (!tr) return null;
      return Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
    })()`);
    console.log("[A] /admin/crews/encre T윤서진 행 셀:", JSON.stringify(row));
    if (row) {
      const tr = page.locator("tr", { hasText: "윤서진" }).first();
      await tr.scrollIntoViewIfNeeded().catch(() => {});
    }
    await page.screenshot({
      path: "claudedocs/week-sot-crews-browser.png",
      fullPage: false,
    });
    console.log("screenshot: claudedocs/week-sot-crews-browser.png");

    // B) 고객 cluster-4 이력서 카드 (demoUserId)
    const page2 = await ctx.newPage();
    await page2.goto(
      `${customerBase}/cluster-4?demoUserId=${TARGET_UID}&admin=true`,
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );
    await page2.waitForTimeout(12000);
    const resume = await page2.evaluate(`(() => {
      const medal = document.querySelector('.medal-week-num');
      const rows = Array.from(document.querySelectorAll('.resume-activities .activity-row')).map((r) => ({
        season: ((r.querySelector('.activity-season') || {}).textContent || '').trim(),
        period: ((r.querySelector('.activity-period') || {}).textContent || '').trim(),
        badge: ((r.querySelector('.activity-badge') || {}).textContent || '').trim(),
      }));
      return { medal: medal ? medal.textContent : null, rows };
    })()`);
    console.log("[B] 고객 이력서 medal-week-num:", JSON.stringify((resume as any).medal));
    for (const r of (resume as any).rows) console.log("[B] 시즌 행:", JSON.stringify(r));
    await page2.screenshot({
      path: "claudedocs/week-sot-resume-browser.png",
      fullPage: false,
    });
    console.log("screenshot: claudedocs/week-sot-resume-browser.png");
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
