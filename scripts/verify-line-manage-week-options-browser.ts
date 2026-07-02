/**
 * 라인 관리 주차 드롭다운 — info/experience/ability(competency) 세 화면 전 주차 노출 브라우저 검증.
 *   - 세 화면 드롭다운 옵션 수가 동일(같은 season-weeks 전 주차 SoT)한지
 *   - experience/ability 도 캡(≤8)이 아니라 전 주차(>수십)가 보이는지
 *   - 과거 주차 선택 후 조회가 정상 동작(에러 없음)하는지
 *   npx tsx --env-file=.env.local scripts/verify-line-manage-week-options-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};
async function cookies_() {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

async function main() {
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1600, height: 2200 } });
  await ctx.addCookies(await cookies_());
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  // ── info: <select aria-label="개설 결과 주차 선택"> ──
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const infoSel = 'select[aria-label="개설 결과 주차 선택"]';
  await page.waitForSelector(infoSel, { timeout: 30000 });
  const infoCount = await page.$$eval(`${infoSel} option`, (els: any[]) => els.filter((e) => e.value).length);
  ck("info 드롭다운 옵션 수 > 8(전 주차)", infoCount > 8, { infoCount });

  // ── experience: <select aria-label="주차 선택"> ──
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const expSel = 'select[aria-label="주차 선택"]';
  await page.waitForSelector(expSel, { timeout: 30000 });
  const expCount = await page.$$eval(`${expSel} option`, (els: any[]) => els.filter((e) => e.value).length);
  ck("experience 드롭다운 옵션 수 > 8(전 주차)", expCount > 8, { expCount });
  // info 는 현재 선택 주차(필터 밖일 수 있음)를 항상 포함하는 안전장치로 +1 될 수 있어 ±1 허용(같은 전 주차 기준).
  ck("experience ≈ info 옵션 수(같은 전 주차 기준·±1)", Math.abs(expCount - infoCount) <= 1, { expCount, infoCount });
  // 과거 주차 선택 → 조회 정상(에러 없음).
  const expOptionValues = await page.$$eval(`${expSel} option`, (els: any[]) => els.map((e) => e.value).filter(Boolean));
  const expOldValue = expOptionValues[expOptionValues.length - 1];
  await page.selectOption(expSel, expOldValue);
  await page.waitForTimeout(3000);
  const expErr = await page.$('text=/불러오지 못했습니다/');
  ck("experience 과거 주차 선택 후 조회 정상(에러 없음)", !expErr);

  // ── competency(ability): 커스텀 메뉴 — button[aria-label="주차 선택"] 클릭 후 옵션 카운트 ──
  await page.goto(`${BASE}/admin/line-opening/practical-competency?org=encre`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);
  const compToggle = 'button[aria-label="주차 선택"]';
  await page.waitForSelector(compToggle, { timeout: 30000 });
  await page.click(compToggle);
  await page.waitForTimeout(600);
  const compCount = await page.$$eval('div.z-20 button', (els: any[]) => els.length);
  ck("competency 드롭다운 옵션 수 > 8(전 주차)", compCount > 8, { compCount });
  ck("competency ≈ info 옵션 수(같은 전 주차 기준·±1)", Math.abs(compCount - infoCount) <= 1, { compCount, infoCount });
  ck("experience == competency 옵션 수(동일 공용 hook)", compCount === expCount, { compCount, expCount });
  // 과거 주차 선택 → 조회 정상.
  const compButtons = await page.$$('div.z-20 button');
  if (compButtons.length > 0) {
    await compButtons[compButtons.length - 1].click();
    await page.waitForTimeout(3000);
    const compErr = await page.$('text=/불러오지 못했습니다/');
    ck("competency 과거 주차 선택 후 조회 정상(에러 없음)", !compErr);
  }

  await page.screenshot({ path: "claudedocs/qa-line-manage-week-options.png", fullPage: true });
  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
