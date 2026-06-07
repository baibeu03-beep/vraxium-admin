/**
 * 기간 정보 — 년도=2022 + 정렬 오래된 순 최종 화면 검증/스크린샷 (read-only).
 * Usage: npx tsx --env-file=.env.local scripts/verify-period-register-browser-final.ts
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
  await page.goto(`${adminBase}/admin/season-weeks`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.getByTestId("result-count").waitFor({ timeout: 30000 });
  for (let i = 0; i < 30; i++) {
    const t = await page.getByTestId("result-count").innerText();
    if (!t.includes("-")) break;
    await page.waitForTimeout(1000);
  }

  const pickFilter = async (label: string, option: string) => {
    const trigger = page
      .getByText(label, { exact: true })
      .locator("xpath=following-sibling::*[@data-slot='select-trigger'][1]");
    await trigger.click();
    const opt = page.getByRole("option", { name: option, exact: true });
    await opt.waitFor({ state: "visible", timeout: 10000 });
    await opt.click();
    await page.waitForTimeout(400);
  };

  await pickFilter("년도", "2022년");
  await pickFilter("정렬", "오래된 순");

  const countText = await page.getByTestId("result-count").innerText();
  check("년도=2022 결과 3건", countText.includes("3"), countText);
  const firstRowName = await page
    .locator("tbody tr")
    .first()
    .locator("td")
    .first()
    .innerText();
  check("오래된 순 1행=22-SP-01", firstRowName.trim() === "22-SP-01", firstRowName);
  const rowNames = await page.locator("tbody tr td:first-child").allInnerTexts();
  check(
    "행 순서 W1→W2→W3",
    rowNames.map((s) => s.trim()).join(",") === "22-SP-01,22-SP-02,22-SP-03",
    rowNames.join(","),
  );
  await page.screenshot({ path: "claudedocs/browser-period-register-season-weeks-2022.png" });

  await page.close();
  await ctx.close();
  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}

void main();
