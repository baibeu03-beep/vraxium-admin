/**
 * 안정화 점검 브라우저 E2E — 등록 → 라인 정보(registrations 전용) → 개설 드롭다운 흐름.
 *   npx tsx --env-file=.env.local scripts/verify-stabilization-browser.ts
 * READ-ONLY (등록/수정 미수행 — 렌더·목록·드롭다운 확인만).
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
  const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const admin = createClient(supabaseUrl, serviceKey);
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

  const { count: liveRegs } = await sb
    .from("line_registrations")
    .select("*", { count: "exact", head: true });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();

    console.log("=== A) 라인 등록 화면 (등록 폼 전용) ===");
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    check("등록 폼 렌더 (라인명/허브/조직/유닛 링크)", (await page.getByLabel("소속 허브").count()) === 1 && (await page.getByLabel("소속 조직").count()) === 1 && (await page.getByLabel("유닛 링크").count()) === 1);
    check("등록된 라인 목록은 분리됨 (이 화면에 테이블 없음)", (await page.locator("tbody tr").count()) === 0);

    console.log("\n=== B) 라인 정보 (registrations 전용) ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const rows = await page.locator("tbody tr").count();
    check(
      `registrations 전 건 표시 (live=${liveRegs})`,
      rows === (liveRegs ?? 0),
      `rows=${rows}`,
    );
    check("수정 액션 노출", (await page.getByRole("button", { name: "수정" }).count()) > 0);
    await page.screenshot({ path: "claudedocs/browser-stabilization-line-info.png", fullPage: true });

    console.log("\n=== C) 개설 드롭다운 (registrations 기준 목록) ===");
    await page.goto(`${baseUrl}/admin/line-opening/practical-competency`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    // 마스터 read-mirror 탭의 목록(= registrations 기준 listCompetencyLineMasters)이 30건인지
    await page.getByRole("button", { name: "라인 등록" }).first().click();
    await page.waitForTimeout(800);
    const masterRows = await page.locator("tbody tr").count();
    check("역량 목록 30건 (registrations 기준 제공)", masterRows === 30, `rows=${masterRows}`);
    check("Deprecated 배너 유지", await page.getByText("[Deprecated · read-mirror]").isVisible());

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
