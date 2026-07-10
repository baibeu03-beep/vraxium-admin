/**
 * /admin/season-weeks 드롭다운 label==선택후표시 + 필터바 레이아웃 검증 (READ-ONLY).
 *   npx tsx --env-file=.env.local scripts/verify-season-weeks-dropdown-and-layout.mjs
 * 1) 4개 드롭다운(정렬·연도·시즌·활동): 옵션 문구 == 선택후 트리거 문구, raw 코드/숫자 미노출.
 * 2) '연도' 라벨 표시('년도' 아님) 확인.
 * 3) 필터 변경 시 서버 재요청 없음(필터=클라이언트 전용) → API value 불변.
 * 4) 1440/1280/1024 레이아웃 스크린샷 + 겹침/가로스크롤 점검.
 * PERIODS_QUERY 로 ?mode=test&org=... 주입 가능.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const query = process.env.PERIODS_QUERY ?? "";
const tag = process.env.SHOT_TAG ?? "default";

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
  const server = createServerClient(supabaseUrl, anonKey, { cookies: { getAll: () => [], setAll: (i) => captured.push(...i) } });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

const RAW_CODES = ["latest", "oldest", "spring", "summer", "autumn", "winter", "official", "rest", "__all__", "전체"];
function looksRaw(t) {
  const s = t.trim();
  if (RAW_CODES.includes(s)) return true;
  if (/^\d{4}$/.test(s)) return true; // "2026" (년 없음)
  return false;
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const results = [];
  let failures = 0;
  let apiCallCount = 0;
  const layout = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on("request", (req) => {
      if (req.url().includes("/api/admin/season-weeks")) apiCallCount++;
    });

    await page.goto(`${baseUrl}/admin/season-weeks${query}`, { waitUntil: "networkidle" });
    console.log(`URL: /admin/season-weeks${query}`);
    await page.waitForTimeout(500);
    const apiAfterLoad = apiCallCount;

    // '연도' 라벨(필터) 확인 — '년도' 이면 실패.
    const hasYeondo = await page.locator('span:has-text("연도")').first().isVisible().catch(() => false);
    const hasYeondoOld = (await page.locator('text=/년도/').count()) > 0;
    console.log(`filter label '연도' visible: ${hasYeondo} · '년도' present: ${hasYeondoOld}`);
    if (!hasYeondo || hasYeondoOld) failures++;

    function trig(labelText) {
      return page.locator(`span:text-is("${labelText}")`).locator("xpath=..").locator('[role="combobox"]').first();
    }
    async function testField(labelText, pick) {
      const t = trig(labelText);
      await t.scrollIntoViewIfNeeded();
      const before = (await t.innerText()).trim(); // 기본값 표시(예: 정렬=최신 순, 나머지=-)
      await t.click();
      const lb = page.locator('[role="listbox"]').last();
      await lb.waitFor({ state: "visible", timeout: 5000 });
      const opts = lb.locator('[role="option"]');
      const n = await opts.count();
      const optTexts = [];
      for (let i = 0; i < n; i++) optTexts.push((await opts.nth(i).innerText()).trim());
      const realIdx = [];
      for (let i = 0; i < optTexts.length; i++) if (optTexts[i] !== "-") realIdx.push(i);
      const chooseIdx = realIdx[Math.min(pick, realIdx.length - 1)];
      const chosen = optTexts[chooseIdx];
      await opts.nth(chooseIdx).click();
      await page.waitForTimeout(120);
      const after = (await t.innerText()).trim();
      const match = after === chosen;
      const raw = looksRaw(after) || looksRaw(before);
      if (!match || raw) failures++;
      results.push({ field: labelText, defaultShown: before, optionShown: chosen, triggerShown: after, match, rawLeak: raw });
    }

    await testField("정렬", 1); // 오래된 순
    await testField("연도", 0); // 2026년
    await testField("시즌", 0); // 봄
    await testField("활동", 1); // 공식 휴식

    // 필터 변경으로 서버 재요청이 발생하지 않아야 함(클라이언트 필터).
    const apiAfterFilters = apiCallCount;
    const noRefetch = apiAfterFilters === apiAfterLoad;
    console.log(`season-weeks API calls: load=${apiAfterLoad}, afterFilters=${apiAfterFilters}, noRefetch=${noRefetch}`);
    if (!noRefetch) failures++;

    // 레이아웃 스크린샷 + 겹침/가로스크롤 점검
    for (const w of [1440, 1280, 1024]) {
      await page.setViewportSize({ width: w, height: 950 });
      await page.waitForTimeout(200);
      const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      // 필터바(카드) 안 좌측 필터영역과 우측 결과영역 겹침 점검
      const overlap = await page.evaluate(() => {
        const rc = document.querySelector('[data-testid="result-count"]');
        if (!rc) return { ok: false, reason: "no result-count" };
        const rcBox = rc.getBoundingClientRect();
        // 필터 combobox 들
        const combos = [...document.querySelectorAll('[role="combobox"]')];
        for (const c of combos) {
          const b = c.getBoundingClientRect();
          // 같은 행(수직 겹침) 이면서 결과영역과 가로로 겹치면 실패
          const sameRow = b.top < rcBox.bottom && b.bottom > rcBox.top;
          const xOverlap = b.right > rcBox.left && b.left < rcBox.right;
          if (sameRow && xOverlap) return { ok: false, reason: "filter overlaps result-count" };
        }
        return { ok: true };
      });
      await page.screenshot({ path: `claudedocs/qa-sw-filterbar-${tag}-${w}.png`, fullPage: false, clip: { x: 0, y: 0, width: w, height: 320 } });
      layout.push({ width: w, horizontalScroll: scrollX, overlap: overlap.ok ? "none" : overlap.reason });
      if (scrollX > 0 || !overlap.ok) failures++;
    }

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log("\n=== dropdowns ===");
  console.log(JSON.stringify(results, null, 2));
  console.log("\n=== layout ===");
  console.log(JSON.stringify(layout, null, 2));
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${results.length} dropdowns + layout, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
