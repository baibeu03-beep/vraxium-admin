/**
 * 브라우저 E2E 검증: /admin/lines/register 레이아웃 개정 (2026-06-07 v3).
 *   npx tsx --env-file=.env.local scripts/verify-line-register-layout-v3-browser.ts
 * 개정: 우측 상단 단독 유닛 링크 제거 → 라인 코드와 같은 행(1:1).
 *   1행 라인명(전체 폭) / 2행 허브·종류(1:1) / 3행 코드·유닛링크(1:1) / 4행 메인 타이틀(전체 폭) / 5행 경력 전용.
 * 항목: geometry(행 배치·1:1 width) · 기능 회귀(허브 연동·등록·unit_link 저장) ·
 *       direct(listLineRegistrations) vs HTTP GET 응답 일치 · 스크린샷 (claudedocs/).
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineRegistrations } from "../lib/adminLineRegistrationsData";

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

type Box = { x: number; y: number; width: number; height: number };
const sameRow = (a: Box, b: Box) => Math.abs(a.y - b.y) < 8;
const ratioOk = (a: Box, b: Box) => Math.abs(a.width - b.width) / Math.max(a.width, b.width) < 0.03;

async function main() {
  const stamp = Date.now();
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sbAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // admin 세션 쿠키 (기존 스크립트 공통 패턴)
  const admin = createClient(supabaseUrl, serviceKey);
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
  const cookieHeader = captured.map((c) => `${c.name}=${c.value}`).join("; ");

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1380, height: 1000 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    console.log("=== A) 레이아웃 geometry (lg 뷰포트 1380px) ===");
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    const nameBox = (await page.getByPlaceholder("예) 마케팅 전략 라인").boundingBox()) as Box;
    const hubBox = (await page.getByLabel("소속 허브").boundingBox()) as Box;
    const typeBox = (await page.getByLabel("라인 종류").boundingBox()) as Box;
    const codeBox = (await page.getByPlaceholder("예) WCBS-NL0001").boundingBox()) as Box;
    const linkBox = (await page.getByLabel("유닛 링크").boundingBox()) as Box;
    const titleBox = (await page.getByPlaceholder("메인 타이틀을 입력하세요").boundingBox()) as Box;

    check("유닛 링크 입력창 1개만 존재 (우측 단독 배치 제거)", (await page.getByLabel("유닛 링크").count()) === 1);
    check("1행: 라인명 단독 (허브보다 위)", nameBox.y < hubBox.y);
    check(
      "1행: 라인명 전체 폭 (우측 끝 ≈ 유닛 링크 우측 끝)",
      Math.abs(nameBox.x + nameBox.width - (linkBox.x + linkBox.width)) < 8,
      `name right=${(nameBox.x + nameBox.width).toFixed(0)} link right=${(linkBox.x + linkBox.width).toFixed(0)}`,
    );
    check("2행: 소속 허브 | 라인 종류 같은 행", sameRow(hubBox, typeBox), `y=${hubBox.y}/${typeBox.y}`);
    check("2행: 허브·종류 width 1:1", ratioOk(hubBox, typeBox), `w=${hubBox.width}/${typeBox.width}`);
    check("3행: 라인 코드 | 유닛 링크 같은 행", sameRow(codeBox, linkBox), `y=${codeBox.y}/${linkBox.y}`);
    check(
      "3행: 라인 코드·유닛 링크 width 1:1",
      ratioOk(codeBox, linkBox),
      `w=${codeBox.width.toFixed(0)}/${linkBox.width.toFixed(0)}`,
    );
    check("3행이 2행 아래", codeBox.y > hubBox.y);
    check("4행: 메인 타이틀이 3행 아래", titleBox.y > codeBox.y);
    check(
      "4행: 메인 타이틀 전체 폭",
      Math.abs(titleBox.x + titleBox.width - (linkBox.x + linkBox.width)) < 8,
    );
    check(
      "유닛 링크 안내 문구('-' 저장) 유지",
      await page.getByText('미입력 시 "-" 로 저장됩니다').isVisible(),
    );
    check(
      "5행: 실무 경력 전용 영역이 메인 타이틀 아래",
      ((await page.getByText("실무 경력 전용 입력").boundingBox()) as Box).y > titleBox.y,
    );
    await page.screenshot({ path: "claudedocs/browser-line-register-layout-v3.png", fullPage: true });

    console.log("\n=== B) 기능 회귀 (허브 연동 · 등록 · unit_link 저장) ===");
    const hubSelect = page.getByLabel("소속 허브");
    const typeSelect = page.getByLabel("라인 종류");
    check("초기: 라인 종류 비활성", await typeSelect.isDisabled());
    await hubSelect.selectOption("experience");
    const expOptions = await typeSelect.locator("option").allTextContents();
    check(
      "허브→종류 연동 유지 (실무 경험)",
      JSON.stringify(expOptions) === JSON.stringify(["도출", "분석", "평가", "관리", "확장"]),
      JSON.stringify(expOptions),
    );
    const unitText = `레이아웃v3 유닛링크 ${stamp}`;
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`레이아웃 V3 라인 ${stamp}`);
    await page.getByPlaceholder("예) WCBS-NL0001").fill(`LAY3-${stamp}`);
    await page.getByLabel("유닛 링크").fill(unitText);
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("레이아웃 검증 타이틀");
    await page.screenshot({ path: "claudedocs/browser-line-register-layout-v3-filled.png", fullPage: true });
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForSelector("text=라인이 등록되었습니다", { timeout: 15000 });
    check("등록 성공 안내 노출", true);
    const { data: dbRow } = await sbAdmin
      .from("line_registrations")
      .select("unit_link,main_title,hub,line_type")
      .eq("line_code", `LAY3-${stamp}`)
      .maybeSingle();
    check("DB 실저장 + unit_link 동일", dbRow?.unit_link === unitText, JSON.stringify(dbRow));
    await page.getByRole("button", { name: "새로고침" }).click();
    await page.waitForTimeout(1200);
    check("목록 유닛 링크 컬럼 노출", await page.getByRole("cell", { name: unitText }).isVisible());

    console.log("\n=== C) direct(listLineRegistrations) vs HTTP GET 일치 ===");
    const direct = await listLineRegistrations({ hub: null, limit: 5, offset: 0 });
    const httpRes = await fetch(`${baseUrl}/api/admin/lines/registrations?limit=5`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    const httpJson = await httpRes.json();
    check("HTTP 200 + success", httpRes.status === 200 && httpJson.success === true);
    check("direct.total == HTTP total", direct.total === httpJson.data.total, `${direct.total}/${httpJson.data.total}`);
    check(
      "direct rows == HTTP rows (deep equal)",
      JSON.stringify(direct.rows) === JSON.stringify(httpJson.data.rows),
    );
    check(
      "최신 행 = 방금 브라우저 등록건",
      httpJson.data.rows[0]?.lineCode === `LAY3-${stamp}`,
      httpJson.data.rows[0]?.lineCode,
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
