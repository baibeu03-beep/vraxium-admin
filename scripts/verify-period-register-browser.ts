/**
 * 기간 등록 — 브라우저 실반영 검증 (Playwright).
 *   1) /admin/periods/register: 기간선택.1=2022 → 기간선택.2 활성화·후보 형식 확인,
 *      2022 봄 W3(03-21~03-27)·공식 휴식·비고 입력 → 등록 성공 메시지
 *   2) 동일 조합 재등록 → 프론트 중복 팝업 "동일한 주차 정보를 가진 기간이 있습니다."
 *   3) /admin/season-weeks: 년도=2022 필터 → 결과 3건(W1·W2 HTTP등록 + W3 브라우저등록),
 *      W3 행 활동=공식 휴식·비고 노출, 정렬 오래된 순 1행=W1
 * 사전조건: admin dev :3000 + verify-period-register-http.ts 선행(2022-spring W1·W2 잔존).
 * Usage: npx tsx --env-file=.env.local scripts/verify-period-register-browser.ts
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

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const W3_LABEL = "22. 03. 21. (월) ~ 22. 03. 27. (일)";

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });
  const cookieDomain = new URL(adminBase).hostname;
  const cookies = await makeAdminCookies();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await ctx.addCookies(cookies.map((k) => ({ ...k, domain: cookieDomain, path: "/" })));
  const page = await ctx.newPage();

  // base-ui Select 조작 헬퍼: 라벨 옆 트리거 클릭 → 옵션 visible 대기 후 클릭
  const pickByLabel = async (fieldLabel: string, optionText: string) => {
    const field = page
      .locator("div.flex.flex-col", { hasText: fieldLabel })
      .filter({ has: page.locator('[data-slot="select-trigger"]') })
      .last();
    await field.locator('[data-slot="select-trigger"]').click();
    const option = page.getByRole("option", { name: optionText, exact: true });
    await option.waitFor({ state: "visible", timeout: 10000 });
    await option.click();
  };

  console.log("=== 1) /admin/periods/register — 신규 등록 (2022 봄 W3, 공식 휴식) ===");
  await page.goto(`${adminBase}/admin/periods/register`, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });
  await page.getByText("기간 선택.1 — 연도 기준").waitFor({ timeout: 30000 });

  const periodTrigger = page
    .locator("div.flex.flex-col", { hasText: "기간 선택.2" })
    .last()
    .locator('[data-slot="select-trigger"]');
  check("기간 선택.2 초기 비활성", await periodTrigger.isDisabled());

  await pickByLabel("기간 선택.1 — 연도 기준", "2022년");
  check("기간 선택.1 선택 후 기간 선택.2 활성", !(await periodTrigger.isDisabled()));

  await periodTrigger.click();
  const candidate = page.getByRole("option", { name: W3_LABEL, exact: true });
  await candidate.waitFor({ state: "visible", timeout: 15000 });
  check("주차 후보 표시 형식 일치", (await candidate.count()) === 1);
  const optionCount = await page.getByRole("option").count();
  check("2022년 주차 후보 52개(+선택 1)", optionCount === 53, `실제=${optionCount}`);
  await candidate.click();

  await pickByLabel("연도 선택", "2022년");
  await pickByLabel("시즌 선택", "봄");
  await pickByLabel("주차 선택", "3주차");
  await pickByLabel("활동 선택", "공식 휴식");
  await page.getByPlaceholder("예: 설 연휴 휴식").fill("브라우저 검증 휴식");

  await page.screenshot({ path: "claudedocs/browser-period-register-filled.png" });

  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.accept();
  });

  await page.getByRole("button", { name: "기간 등록" }).click();
  await page
    .getByText("가 등록되었습니다.")
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  const successShown = await page.getByText("가 등록되었습니다.").count();
  check("등록 성공 메시지 노출", successShown > 0, dialogs.join(" / "));
  await page.screenshot({ path: "claudedocs/browser-period-register-success.png" });

  console.log("\n=== 2) 동일 조합 재등록 → 중복 팝업 ===");
  // 폼은 성공 후 초기화됨 — 같은 값 재입력
  await pickByLabel("기간 선택.1 — 연도 기준", "2022년");
  await periodTrigger.click();
  const candidate2 = page.getByRole("option", { name: W3_LABEL, exact: true });
  await candidate2.waitFor({ state: "visible", timeout: 15000 });
  await candidate2.click();
  await pickByLabel("연도 선택", "2022년");
  await pickByLabel("시즌 선택", "봄");
  await pickByLabel("주차 선택", "3주차");
  await pickByLabel("활동 선택", "공식 활동");
  dialogs.length = 0;
  await page.getByRole("button", { name: "기간 등록" }).click();
  await page.waitForTimeout(2000);
  check(
    '중복 팝업 "동일한 주차 정보를 가진 기간이 있습니다."',
    dialogs.includes("동일한 주차 정보를 가진 기간이 있습니다."),
    `실제=${dialogs.join(" / ") || "(팝업 없음)"}`,
  );

  console.log("\n=== 3) /admin/season-weeks — 기간 정보 반영 ===");
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
  const totalText = await page.getByTestId("result-count").innerText();
  check("전체 결과 156건(153+3)", totalText.includes("156"), totalText);

  // 년도=2022 필터
  const yearFilter = page
    .locator("div.flex.items-center", { hasText: "년도" })
    .last()
    .locator('[data-slot="select-trigger"]');
  await yearFilter.click();
  const opt2022 = page.getByRole("option", { name: "2022년", exact: true });
  await opt2022.waitFor({ state: "visible", timeout: 10000 });
  await opt2022.click();
  await page.waitForTimeout(500);
  const filteredText = await page.getByTestId("result-count").innerText();
  check("년도=2022 필터 결과 3건", filteredText.includes("3"), filteredText);

  const bodyText = await page.evaluate(() => document.body.innerText);
  check("W1 행 노출(22-SP-01)", bodyText.includes("22-SP-01"));
  check("W2 행 노출(22-SP-02)", bodyText.includes("22-SP-02"));
  check("W3 행 노출(22-SP-03)", bodyText.includes("22-SP-03"));
  check("W3 비고 노출", bodyText.includes("브라우저 검증 휴식"));

  // W3 행 자체의 활동 배지=공식 휴식 (행 단위 검사)
  const w3Row = page.locator("tbody tr", { hasText: "22-SP-03" });
  const w3RowText = await w3Row.innerText();
  check("W3 행 활동=공식 휴식", w3RowText.includes("공식 휴식"), w3RowText.replace(/\s+/g, " "));
  const w2Row = page.locator("tbody tr", { hasText: "22-SP-02" });
  check("W2 행 활동=공식 휴식(HTTP 휴식 등록분)", (await w2Row.innerText()).includes("공식 휴식"));
  const w1Row = page.locator("tbody tr", { hasText: "22-SP-01" });
  check("W1 행 활동=공식 활동", (await w1Row.innerText()).includes("공식 활동"));

  // 활동=공식 휴식 필터 → 2건(W2·W3)
  const activityFilter = page
    .locator("div.flex.items-center", { hasText: "활동" })
    .last()
    .locator('[data-slot="select-trigger"]');
  await activityFilter.click();
  const optRest = page.getByRole("option", { name: "공식 휴식", exact: true });
  await optRest.waitFor({ state: "visible", timeout: 10000 });
  await optRest.click();
  await page.waitForTimeout(500);
  const restFilteredText = await page.getByTestId("result-count").innerText();
  check("년도=2022+활동=공식 휴식 결과 2건", restFilteredText.includes("2"), restFilteredText);

  // 정렬: 오래된 순 → 첫 행 = W1(2022-03-07) — 활동 필터 초기화 후
  await activityFilter.click();
  const optAll = page.getByRole("option", { name: "-", exact: true });
  await optAll.waitFor({ state: "visible", timeout: 10000 });
  await optAll.click();
  const sortFilter = page
    .locator("div.flex.items-center", { hasText: "정렬" })
    .last()
    .locator('[data-slot="select-trigger"]');
  await sortFilter.click();
  const optOldest = page.getByRole("option", { name: "오래된 순", exact: true });
  await optOldest.waitFor({ state: "visible", timeout: 10000 });
  await optOldest.click();
  await page.waitForTimeout(500);
  const firstRowName = await page.locator("tbody tr").first().locator("td").first().innerText();
  check("오래된 순 1행=22-SP-01", firstRowName.trim() === "22-SP-01", firstRowName);

  await page.screenshot({ path: "claudedocs/browser-period-register-season-weeks-2022.png" });

  await page.close();
  await ctx.close();
  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}

void main();
