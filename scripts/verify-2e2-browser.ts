/**
 * Phase 2E-2 브라우저 확인: 마스터 관리 화면 가드 안내 배너 + 라인 정보 정상.
 *   npx tsx --env-file=.env.local scripts/verify-2e2-browser.ts
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
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    console.log("=== A) 역량 마스터 화면 — 가드 배너 ===");
    await page.goto(`${baseUrl}/admin/line-opening/practical-competency`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "라인 등록" }).first().click();
    await page.waitForTimeout(800);
    check(
      "역량 화면 — 통합 등록 유도 배너 노출",
      await page.getByText("이 화면의 직접 생성/삭제는 중단되었습니다").isVisible(),
    );
    await page.screenshot({ path: "claudedocs/browser-2e2-guard-competency.png", fullPage: true });

    console.log("\n=== B) 경험 마스터 화면 — 가드 배너 ===");
    await page.goto(`${baseUrl}/admin/line-opening/practical-experience`, { waitUntil: "networkidle" });
    const masterTab = page.getByRole("button", { name: "라인 등록" }).first();
    if ((await masterTab.count()) > 0) await masterTab.click();
    await page.waitForTimeout(800);
    check(
      "경험 화면 — 통합 등록 유도 배너 노출",
      await page.getByText("이 화면의 직접 생성/삭제는 중단되었습니다").isVisible(),
    );

    console.log("\n=== C) career 화면 — soft 안내 ===");
    await page.goto(`${baseUrl}/admin/line-opening/practical-career`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    check(
      "career 화면 — 권장 안내(soft) 노출 + 기존 기능 유지 문구",
      await page.getByText("기존 등록/수정 기능은 그대로 사용할 수 있습니다").isVisible(),
    );
    await page.screenshot({ path: "claudedocs/browser-2e2-guard-career.png", fullPage: true });

    console.log("\n=== D) 라인 정보 정상 ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=통합 라인 목록", { timeout: 15000 });
    check(
      "라인 정보 113건 정상",
      Boolean(await page.getByText(/신규 등록 56/).first().isVisible()),
    );

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
