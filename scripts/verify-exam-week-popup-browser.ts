/**
 * 시험기간 주차 공식 활동 차단 — 프론트 팝업 브라우저 검증 (서버 미도달, FE 선차단).
 *   2022 봄 W6 + 공식 활동 → alert "해당 주차는 시험기간 공식 휴식 주차입니다."
 * Usage: npx tsx --env-file=.env.local scripts/verify-exam-week-popup-browser.ts
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
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies(
    cookies.map((k) => ({ ...k, domain: new URL(adminBase).hostname, path: "/" })),
  );
  const page = await ctx.newPage();
  await page.goto(`${adminBase}/admin/periods/register`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.getByText("기간 선택.1", { exact: true }).waitFor({ timeout: 30000 });

  const pick = async (label: string, optionText: string) => {
    const field = page
      .locator("div.flex.flex-col", { hasText: label })
      .filter({ has: page.locator('[data-slot="select-trigger"]') })
      .last();
    await field.locator('[data-slot="select-trigger"]').click();
    const option = page.getByRole("option", { name: optionText, exact: true });
    await option.waitFor({ state: "visible", timeout: 10000 });
    await option.click();
  };

  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });
  let postCount = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/admin/season-weeks")) postCount++;
  });

  await pick("기간 선택.1", "2022년");
  await pick("기간 선택.2", "22. 04. 11. (월) ~ 22. 04. 17. (일)");
  await pick("연도 선택", "2022년");
  await pick("시즌 선택", "봄");
  await pick("주차 선택", "6주차");
  await pick("활동 선택", "공식 활동");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.waitForTimeout(1500);

  check(
    '팝업 "해당 주차는 시험기간 공식 휴식 주차입니다."',
    dialogs.includes("해당 주차는 시험기간 공식 휴식 주차입니다."),
    dialogs.join(" / ") || "(팝업 없음)",
  );
  check("FE 선차단 — POST 미발생", postCount === 0, `POST ${postCount}회`);
  await page.screenshot({ path: "claudedocs/browser-exam-week-block.png" });

  await page.close();
  await ctx.close();
  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}

void main();
