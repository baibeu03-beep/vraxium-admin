/**
 * /admin/periods/register 드롭다운 label==선택후표시 검증 (READ-ONLY, 폼 제출 안 함).
 *   npx tsx --env-file=.env.local scripts/verify-periods-register-dropdown-labels.mjs
 * 각 Select: (1) 열어 옵션 문구 수집 → (2) 특정 옵션 선택 → (3) 트리거 표시 문구 확인.
 * 옵션문구==트리거문구 & 영문코드/접미사없는숫자 노출 없음 을 단언.
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
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

// 표시 문구에 영문코드/접미사없는 숫자만 노출되면 실패로 간주.
const RAW_CODES = ["winter", "spring", "summer", "autumn", "official", "rest", "transition", "__none__"];
function looksRaw(text) {
  const t = text.trim();
  if (RAW_CODES.includes(t)) return true;
  if (/^\d{4}$/.test(t)) return true; // "2026" (년 접미사 없음)
  if (/^\d{1,2}$/.test(t)) return true; // "5" (주차 접미사 없음)
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return true; // ISO date raw
  return false;
}

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const results = [];
  let failures = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // 실제 HTTP 요청 value 검증용: season-weeks POST body 캡처(제출은 안 하므로 실제로는 안 뜸)
    const query = process.env.PERIODS_QUERY ?? "";
    await page.goto(`${baseUrl}/admin/periods/register${query}`, { waitUntil: "networkidle" });
    console.log(`URL: /admin/periods/register${query}`);

    // 트리거는 각 FormField 안 combobox. 라벨 텍스트로 스코프.
    const fieldOrder = [
      { field: "기간 선택.1", pick: 0, dependent: false },
      { field: "연도 선택", pick: 1, dependent: false },
      { field: "시즌 선택", pick: 0, dependent: false }, // 겨울
      { field: "주차 선택", pick: 5, dependent: false }, // 5주차
      { field: "활동 선택", pick: 0, dependent: false }, // 공식 활동
      { field: "기간 선택.1", pick: 0, dependent: false, prep: true }, // 후보용 연도 먼저
      { field: "기간 선택.2", pick: 1, dependent: true }, // 후보 날짜
    ];

    async function triggerFor(labelText) {
      // FormField div = 라벨 span 의 부모. 그 안의 combobox 로 스코프.
      return page
        .locator(`span:text-is("${labelText}")`)
        .locator("xpath=..")
        .locator('[role="combobox"]')
        .first();
    }

    async function testField(labelText, pick) {
      const trig = await triggerFor(labelText);
      await trig.scrollIntoViewIfNeeded();
      await trig.click();
      // 옵션 popup
      const listbox = page.locator('[role="listbox"]').last();
      await listbox.waitFor({ state: "visible", timeout: 5000 });
      const opts = listbox.locator('[role="option"]');
      const n = await opts.count();
      const optTexts = [];
      for (let i = 0; i < n; i++) optTexts.push((await opts.nth(i).innerText()).trim());
      // "-" (미선택) 제외한 실제 값 인덱스 중 pick 번째
      const realIdx = [];
      for (let i = 0; i < optTexts.length; i++) if (optTexts[i] !== "-") realIdx.push(i);
      const chooseIdx = realIdx[Math.min(pick, realIdx.length - 1)];
      const chosenOptText = optTexts[chooseIdx];
      await opts.nth(chooseIdx).click();
      await page.waitForTimeout(150);
      const trigText = (await trig.innerText()).trim();
      const match = trigText === chosenOptText;
      const raw = looksRaw(trigText);
      if (!match || raw) failures++;
      results.push({
        field: labelText,
        optionShown: chosenOptText,
        triggerShown: trigText,
        match,
        rawLeak: raw,
      });
      return chosenOptText;
    }

    // 독립 필드
    await testField("기간 선택.1", 0); // 연도 후보 세팅도 겸함
    await testField("연도 선택", 1);
    await testField("시즌 선택", 0);
    await testField("주차 선택", 5);
    await testField("활동 선택", 0);
    // 종속 필드: 기간 선택.2 (기간 선택.1 이 이미 선택됨 → 후보 존재)
    await testField("기간 선택.2", 1);

    await page.screenshot({
      path: "claudedocs/verify-periods-register-labels.png",
      fullPage: true,
    });
    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${results.length} dropdowns, ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
