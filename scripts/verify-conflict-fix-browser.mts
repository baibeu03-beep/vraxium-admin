/**
 * B/C그룹 보정 후 브라우저 확인:
 *  - 2025년 필터 → 25-WI-05(설 연휴 주차)가 "공식 휴식" 표시
 *  - 2024년 필터 → 24-AU-06/07/08/14/15/16 "공식 휴식" 표시
 *   npx tsx --env-file=.env.local scripts/verify-conflict-fix-browser.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
const requireFromFront = createRequire(new URL("../../vraxium/package.json", import.meta.url));
const { chromium } = requireFromFront("playwright") as typeof import("playwright");
const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const admin = createClient(supabaseUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData!.properties!.email_otp, type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => { captured.push(...items); } },
  });
  await server.auth.setSession({
    access_token: verifyData!.session!.access_token,
    refresh_token: verifyData!.session!.refresh_token,
  });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/" }));
}

async function pickYear(page: import("playwright").Page, label: string) {
  await page.locator('[data-slot="select-trigger"]').nth(1).click();
  await page.getByRole("option", { name: label, exact: true }).first().click();
  await page.waitForTimeout(250);
}

async function rowsMap(page: import("playwright").Page) {
  return (await page.evaluate(
    "Array.from(document.querySelectorAll('table tbody tr')).map(tr => ({ code: tr.children[0].textContent.trim(), activity: tr.children[5].textContent.trim(), remark: tr.children[6].textContent.trim() }))",
  )) as Array<{ code: string; activity: string; remark: string }>;
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto("/admin/season-weeks", { waitUntil: "networkidle" });

    await pickYear(page, "2025년");
    // 2025년 결과가 20행 초과 → 겨울 시즌 필터로 좁혀 1페이지에서 확인
    await page.locator('[data-slot="select-trigger"]').nth(2).click();
    await page.getByRole("option", { name: "겨울", exact: true }).first().click();
    await page.waitForTimeout(250);
    const r25 = await rowsMap(page);
    const wi05 = r25.find((r) => r.code === "25-WI-05");
    check("[C] 25-WI-05 행 존재(2025년 필터)", Boolean(wi05));
    check("[C] 25-WI-05 활동 = 공식 휴식", wi05?.activity === "공식 휴식", `${wi05?.activity}`);
    check("[C] 25-WI-05 비고 = 설 연휴", wi05?.remark === "설 연휴", `'${wi05?.remark}'`);
    // HTTP API: holiday_name 필드 확인
    const apiRes = await ctx.request.get("/api/admin/season-weeks");
    const apiRows = (await apiRes.json())?.data?.rows ?? [];
    const apiW5 = apiRows.find((r: { week_id: string }) => r.week_id === "b39ebb3d-7d9f-444d-84b1-8e2ed858b2d5");
    check("[C] HTTP API 25-WI-05 holiday_name = 설 연휴", apiW5?.holiday_name === "설 연휴", `'${apiW5?.holiday_name}'`);
    await page.screenshot({ path: "claudedocs/browser-conflict-fix-2025.png" });

    await page.getByRole("button", { name: "초기화" }).click();
    await page.waitForTimeout(250);
    await pickYear(page, "2024년");
    await page.locator('[data-slot="select-trigger"]').nth(2).click();
    await page.getByRole("option", { name: "가을", exact: true }).first().click();
    await page.waitForTimeout(250);
    const r24 = await rowsMap(page);
    for (const code of ["24-AU-06", "24-AU-07", "24-AU-08", "24-AU-14", "24-AU-15", "24-AU-16"]) {
      const row = r24.find((r) => r.code === code);
      check(`[B] ${code} 활동 = 공식 휴식`, row?.activity === "공식 휴식", `${row?.activity ?? "행 미노출(2페이지?)"}`);
    }
    await page.screenshot({ path: "claudedocs/browser-conflict-fix-2024.png" });
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
