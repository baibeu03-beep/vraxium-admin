/**
 * 스크린샷 + 상태별 검증 — Select sentinel 라벨이 닫힘/열림/선택후/새로고침 모든 상태에서
 * "전체"로 보이는지 확인. 결과 PNG 를 ./screenshots-select 에 저장.
 *   dev 서버 가동 후: npx tsx --env-file=.env.local scripts/shot-select-sentinel.ts
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OUT = "screenshots-select";

function assert(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  assert(verified.session, "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({ access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
  return captured.map(({ name, value }) => ({ name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function triggerTexts(page: import("playwright-core").Page) {
  return page.$$eval('[data-slot="select-value"]', (els) => els.map((e) => (e.textContent ?? "").trim()));
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const step = async (label: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { console.log(`   ⚠ ${label} 일부 실패: ${(e as Error).message.split("\n")[0]}`); }
  };
  try {
    // ── WeeklyCardFinalization ──
    await page.goto(`${baseUrl}/admin/weekly-card-finalization`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    console.log(`1) [닫힌 상태] 트리거: ${JSON.stringify(await triggerTexts(page))}`);
    await page.screenshot({ path: `${OUT}/01-finalization-closed.png` });

    const triggers = page.locator('[data-slot="select-trigger"]');
    await step("시즌 열기", async () => {
      await triggers.nth(0).click();
      await page.waitForTimeout(700);
      const items = await page.$$eval('[data-slot="select-item"]', (els) => els.map((e) => (e.textContent ?? "").trim()).slice(0, 6));
      console.log(`2) [열린 상태] 시즌 항목 일부: ${JSON.stringify(items)}`);
      await page.screenshot({ path: `${OUT}/02-finalization-season-open.png` });
    });
    await step("시즌 선택", async () => {
      await page.locator('[data-slot="select-item"]').first().click({ timeout: 5000 });
      await page.waitForTimeout(600);
      console.log(`3) [선택 후] 트리거: ${JSON.stringify(await triggerTexts(page))}`);
      await page.screenshot({ path: `${OUT}/03-finalization-after-select.png` });
    });
    await step("새로고침", async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      console.log(`4) [새로고침 후] 트리거: ${JSON.stringify(await triggerTexts(page))}`);
      await page.screenshot({ path: `${OUT}/04-finalization-after-refresh.png` });
    });

    // ── week-recognitions (직전 4건 누수) ──
    await page.goto(`${baseUrl}/admin/week-recognitions`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    console.log(`5) [week-recognitions] 닫힌 트리거: ${JSON.stringify(await triggerTexts(page))}`);
    await page.screenshot({ path: `${OUT}/05-week-recognitions.png` });

    // ── admin-users (직전 2건 누수) ──
    await page.goto(`${baseUrl}/admin/users/admin-users`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    console.log(`6) [admin-users] 닫힌 트리거: ${JSON.stringify(await triggerTexts(page))}`);
    await page.screenshot({ path: `${OUT}/06-admin-users.png` });
  } finally {
    await browser.close();
  }
  console.log(`\n스크린샷 저장: ./${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });
