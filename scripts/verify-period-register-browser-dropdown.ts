/**
 * 기간 등록 — 기간 선택.2 드롭다운 형식/후보 수 보완 검증 (등록 없음, read-only).
 * 본검증(verify-period-register-browser.ts)에서 팝업 렌더 전 count() 호출로 생긴
 * 타이밍 미스 2건 재확인용: 옵션 visible 대기 후 검사.
 * Usage: npx tsx --env-file=.env.local scripts/verify-period-register-browser-dropdown.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookies(): Promise<Array<{ name: string; value: string }>> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
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

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });
  const cookies = await makeAdminCookies();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await ctx.addCookies(
    cookies.map((k) => ({ ...k, domain: new URL(adminBase).hostname, path: "/" })),
  );
  const page = await ctx.newPage();
  await page.goto(`${adminBase}/admin/periods/register`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.getByText("기간 선택.1 — 연도 기준").waitFor({ timeout: 30000 });

  // 기간 선택.1 = 2026 (수요일 귀속: 2026 첫 주차 = 12-29(월)~01-04(일) 아님 —
  // 수요일 12-31 은 2025 귀속 → 2026 첫 주차는 01-05(월) 시작이어야 한다)
  const field1 = page
    .locator("div.flex.flex-col", { hasText: "기간 선택.1 — 연도 기준" })
    .filter({ has: page.locator('[data-slot="select-trigger"]') })
    .last();
  await field1.locator('[data-slot="select-trigger"]').click();
  await page.getByRole("option", { name: "2026년", exact: true }).click();

  const periodTrigger = page
    .locator("div.flex.flex-col", { hasText: "기간 선택.2" })
    .last()
    .locator('[data-slot="select-trigger"]');
  await periodTrigger.click();
  const first2026 = page.getByRole("option", {
    name: "26. 01. 05. (월) ~ 26. 01. 11. (일)",
    exact: true,
  });
  await first2026.waitFor({ state: "visible", timeout: 15000 });
  check("2026 첫 후보=01-05 주차(12-30 수요일 주는 2025 귀속 제외)", true);
  // 명세 예시 형식 그대로 존재: 26. 06. 29. (월) ~ 26. 07. 05. (일)
  const specExample = page.getByRole("option", {
    name: "26. 06. 29. (월) ~ 26. 07. 05. (일)",
    exact: true,
  });
  check("명세 예시 형식 일치(26. 06. 29. (월) ~ 26. 07. 05. (일))", (await specExample.count()) === 1);
  const count2026 = (await page.getByRole("option").count()) - 1; // "선택" 제외
  check("2026년 주차 후보 52개(2026 수요일 52개)", count2026 === 52, `실제=${count2026}`);
  await page.screenshot({ path: "claudedocs/browser-period-register-dropdown-2026.png" });
  await page.keyboard.press("Escape");

  // 2022 재검: 본검증에서 미스난 2건
  await field1.locator('[data-slot="select-trigger"]').click();
  await page.getByRole("option", { name: "2022년", exact: true }).click();
  await periodTrigger.click();
  const w2 = page.getByRole("option", {
    name: "22. 03. 14. (월) ~ 22. 03. 20. (일)",
    exact: true,
  });
  await w2.waitFor({ state: "visible", timeout: 15000 });
  check("2022 후보 표시 형식 일치(22. 03. 14. (월) ~ 22. 03. 20. (일))", true);
  const count2022 = (await page.getByRole("option").count()) - 1;
  check("2022년 주차 후보 52개", count2022 === 52, `실제=${count2022}`);

  await page.close();
  await ctx.close();
  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}

void main();
