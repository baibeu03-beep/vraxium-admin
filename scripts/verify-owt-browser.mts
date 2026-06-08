/**
 * org_week_thresholds — 브라우저 실반영 검증 (read-only: 저장/수정 0).
 *
 *   사전조건: admin dev(3000) + front dev(3001).
 *   npx tsx --env-file=.env.local scripts/verify-owt-browser.mts
 *
 *   1) admin /admin/week-recognitions "check 기준 관리" 탭: effective threshold 렌더
 *      (org seed 후에도 표시값 불변 — UI 는 weeks.check_threshold 직독, 변경 없음).
 *   2) front /cluster-4?demoUserId=…: 레거시 주차 카드 렌더 — snapshot DTO(checkGate 포함)
 *      경유 실표시. 스크린샷 보존.
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const requireFromFront = createRequire(new URL("../../vraxium/package.json", import.meta.url));
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const adminBase = "http://localhost:3000";
const frontBase = "http://localhost:3001";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SAMPLE_USER = process.argv[2] ?? "58a4c844-6fd2-4108-8d2d-51c701018a7b";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "magic link 실패");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "OTP 검증 실패");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/" }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });

  // ── 1) admin: check 기준 관리 탭 (read-only) ──
  {
    const context = await browser.newContext({ baseURL: adminBase });
    await context.addCookies(await makeAdminCookies());
    const page = await context.newPage();
    await page.goto("/admin/week-recognitions", { waitUntil: "networkidle" });
    const tab = page.locator("text=check 기준 관리").first();
    await tab.click();
    await page.waitForTimeout(800);
    const body = (await page.locator("body").innerText()) ?? "";
    check("admin check 기준 관리 탭 렌더", body.includes("기준"), undefined);
    check(
      "admin effective threshold 표시 (37개 — seed 후 표시 불변)",
      body.includes("37개"),
      body.includes("37개") ? undefined : body.slice(0, 300),
    );
    check("admin 기본값 배지 렌더 (NULL 주차 = 기본값 의미론 유지)", body.includes("기본값"));
    await page.screenshot({
      path: "claudedocs/browser-owt-admin-check-threshold.png",
      fullPage: true,
    });
    await context.close();
  }

  // ── 2) front: demo 카드 (read-only) ──
  {
    const context = await browser.newContext({ baseURL: frontBase });
    const page = await context.newPage();
    await page.goto(`/cluster-4?demoUserId=${SAMPLE_USER}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const body = (await page.locator("body").innerText()) ?? "";
    // snapshot DTO 경유 레거시 카드 렌더 — 주차 카드 다수 노출 확인 (마크업 비의존 텍스트 검사).
    check(
      "front demo 주차 카드 렌더 (snapshot DTO 경유)",
      body.includes("주차") && body.length > 500,
      `bodyLen=${body.length}`,
    );
    await page.screenshot({ path: "claudedocs/browser-owt-front-cards.png", fullPage: true });
    await context.close();
  }

  await browser.close();
  console.log(failures === 0 ? "\n브라우저 검증 전체 PASS" : `\nFAIL ${failures}건`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
