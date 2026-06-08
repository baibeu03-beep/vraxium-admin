/**
 * Phase 2E-6 브라우저 E2E — deprecated 마스터 화면 + 카탈로그 dedup.
 *   npx tsx --env-file=.env.local scripts/verify-2e6-browser.ts
 * READ-ONLY. 스크린샷 2장 (claudedocs/).
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();

    console.log("=== A) 역량 마스터 화면 — deprecated/read-mirror ===");
    await page.goto(`${baseUrl}/admin/line-opening/practical-competency`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "라인 등록" }).first().click();
    await page.waitForTimeout(800);
    check("Deprecated·read-mirror 배너", await page.getByText("[Deprecated · read-mirror]").isVisible());
    check("새 라인 버튼 제거", (await page.getByRole("button", { name: /새 라인/ }).count()) === 0);
    check("행 액션 = '라인 정보에서 수정' 링크", (await page.getByText("라인 정보에서 수정").count()) > 0);
    check(
      "목록 30건 (registrations 기준 제공)",
      (await page.locator("tbody tr").count()) === 30,
      `rows=${await page.locator("tbody tr").count()}`,
    );
    await page.screenshot({ path: "claudedocs/browser-2e6-master-readonly.png", fullPage: true });

    console.log("\n=== B) 경험 마스터 화면 ===");
    await page.goto(`${baseUrl}/admin/line-opening/practical-experience`, { waitUntil: "networkidle" });
    const masterTab = page.getByRole("button", { name: "라인 등록" }).first();
    if ((await masterTab.count()) > 0) await masterTab.click();
    await page.waitForTimeout(800);
    check("경험 — Deprecated 배너 + 수정 링크", (await page.getByText("[Deprecated · read-mirror]").isVisible()) && (await page.getByText("라인 정보에서 수정").count()) > 0);

    console.log("\n=== C) 라인 정보 — read-mirror dedup ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=통합 라인 목록", { timeout: 15000 });
    const desc = await page.getByText(/read-mirror 마스터 \d+건은 기본 숨김/).textContent();
    check("기본 화면 — mirror 숨김 안내 (56건)", Boolean(desc?.includes("read-mirror 마스터 56건")), desc ?? "");
    const visibleRows = await page.locator("tbody tr").count();
    const masterBadges = await page.getByRole("cell", { name: /경험 마스터|역량 마스터/ }).count();
    check(
      "기본 표시에서 exp/comp 마스터 행 숨김 (registration 행이 대표)",
      masterBadges === 0,
      `rows=${visibleRows} masterBadges=${masterBadges}`,
    );
    // 출처 필터로 명시 선택 시 read-mirror 행 노출
    await page.getByLabel("데이터 출처 필터").selectOption("competency_master");
    await page.waitForTimeout(400);
    const mirrorBadges = await page.getByText("· read-mirror").count();
    check("출처 필터 선택 시 read-mirror 행 노출 (뱃지 표시)", mirrorBadges === 30, `mirrorBadges=${mirrorBadges}`);
    await page.screenshot({ path: "claudedocs/browser-2e6-catalog-dedup.png", fullPage: true });

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
