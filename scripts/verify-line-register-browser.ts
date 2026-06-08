/**
 * 브라우저 E2E 검증: /admin/lines/register (unit_link 정정판 UI, 2026-06-07 시안).
 *   npx tsx --env-file=.env.local scripts/verify-line-register-browser.ts
 * 항목: 2열 레이아웃 렌더 · 허브→종류 연동 · 경력 전용 3열 카드 활성/비활성 ·
 *       메인타이틀 고정/변동 · 유닛 링크 단일 텍스트 · 등록(실제 DB 저장) ·
 *       유닛 링크 미입력 '-' 저장 · 목록 노출 · 초기화. 스크린샷 3장 (claudedocs/).
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

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1380, height: 1000 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    console.log("=== A) 초기 렌더 (2열 레이아웃) ===");
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    check("페이지 타이틀 '라인 등록' 노출", await page.getByText("라인 등록", { exact: true }).first().isVisible());
    const hubSelect = page.getByLabel("소속 허브");
    check("허브 기본값 '-'", (await hubSelect.inputValue()) === "-");
    const typeSelect = page.getByLabel("라인 종류");
    check("허브 '-' 시 라인 종류 '-'만", (await typeSelect.inputValue()) === "-");
    check("라인 종류 비활성", await typeSelect.isDisabled());
    const unitLinkInput = page.getByLabel("유닛 링크");
    check("유닛 링크 단일 입력창 노출", await unitLinkInput.isVisible());
    check(
      "유닛 링크 안내 문구('-' 저장) 노출",
      await page.getByText('미입력 시 "-" 로 저장됩니다').isVisible(),
    );
    await page.screenshot({ path: "claudedocs/browser-line-register-v2-initial.png", fullPage: true });

    console.log("\n=== B) 허브 → 라인 종류 연동 + 경력 전용 카드 ===");
    await hubSelect.selectOption("experience");
    const expOptions = await typeSelect.locator("option").allTextContents();
    check(
      "실무 경험 종류 = 도출/분석/평가/관리/확장",
      JSON.stringify(expOptions) === JSON.stringify(["도출", "분석", "평가", "관리", "확장"]),
      JSON.stringify(expOptions),
    );
    check("비career 시 전용 카드 입력 비활성", await page.getByPlaceholder("예) 브랙시움").isDisabled());
    check(
      "비career 안내 문구 노출",
      await page.getByText('소속 허브가 "실무 경력"일 때만 활성화됩니다').isVisible(),
    );
    await hubSelect.selectOption("competency");
    const compOptions = await typeSelect.locator("option").allTextContents();
    check(
      "실무 역량 종류 = 원리/기술/관점/자원",
      JSON.stringify(compOptions) === JSON.stringify(["원리", "기술", "관점", "자원"]),
    );
    await hubSelect.selectOption("career");
    const carOptions = await typeSelect.locator("option").allTextContents();
    check("실무 경력 종류 = 일반", JSON.stringify(carOptions) === JSON.stringify(["일반"]));
    check("career 시 전용 카드 활성", !(await page.getByPlaceholder("예) 브랙시움").isDisabled()));

    console.log("\n=== C) 메인 타이틀 고정/변동 ===");
    const titleInput = page.getByPlaceholder("메인 타이틀을 입력하세요");
    check("고정 모드: 입력 활성", !(await titleInput.isDisabled()));
    await page.getByRole("radio").nth(1).check(); // 변동
    check("변동 모드: 입력 비활성", await titleInput.isDisabled());
    check(
      "변동 안내 문구 노출",
      await page
        .getByText("고정된 메인 타이틀이 없으며, 개설 때 마다 입력하는 1차 정보가 됩니다.")
        .isVisible(),
    );

    console.log("\n=== D) 등록 (변동 + 유닛 링크 텍스트 + career 전용) ===");
    const unitText = `브라우저 유닛링크 메모 ${stamp}`;
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`브라우저 V2 라인 ${stamp}`);
    await page.getByPlaceholder("예) WCBS-NL0001").fill(`WCB2-${stamp}`);
    await unitLinkInput.fill(unitText);
    await page.getByPlaceholder("예) 브랙시움").fill("브라우저제휴사");
    await page.getByPlaceholder("예) 김담당").fill("박브라우저");
    await page.getByPlaceholder("예) 팀장").fill("과장");
    await page.getByPlaceholder("예) 마케팅", { exact: true }).fill("기획");
    await page.getByLabel("프로필 사진").selectOption("토르");
    check("프로필 선택 시 이미지 미리보기 원 표시", await page.getByTestId("profile-preview-circle").isVisible());
    await page.screenshot({ path: "claudedocs/browser-line-register-v2-filled.png", fullPage: true });

    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForSelector("text=라인이 등록되었습니다", { timeout: 15000 });
    check("성공 안내 노출", true);

    const { data: dbRow } = await sbAdmin
      .from("line_registrations")
      .select("*")
      .eq("line_code", `WCB2-${stamp}`)
      .maybeSingle();
    check("DB 실저장 (브라우저 등록건)", Boolean(dbRow));
    check("DB unit_link = 입력 텍스트", dbRow?.unit_link === unitText, dbRow?.unit_link);
    check("변동 → main_title='-'", dbRow?.main_title === "-");
    check("제휴/연계사 저장", dbRow?.partner_company === "브라우저제휴사");
    check("프로필 토큰 저장", dbRow?.manager_profile_key === "토르");
    check(
      "deprecated output_links 미사용",
      Array.isArray(dbRow?.output_links) && dbRow.output_links.length === 0,
    );

    console.log("\n=== E) 유닛 링크 미입력 등록 → '-' ===");
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`브라우저 V2 무링크 ${stamp}`);
    await page.getByLabel("소속 허브").selectOption("info");
    await page.getByPlaceholder("예) WCBS-NL0001").fill(`IFB2-${stamp}`);
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("정보 라인 타이틀");
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForSelector("text=라인이 등록되었습니다", { timeout: 15000 });
    const { data: dbRow2 } = await sbAdmin
      .from("line_registrations")
      .select("unit_link,hub,line_type")
      .eq("line_code", `IFB2-${stamp}`)
      .maybeSingle();
    check("미입력 → DB unit_link='-'", dbRow2?.unit_link === "-", JSON.stringify(dbRow2));

    console.log("\n=== F) 목록 노출 + 초기화 ===");
    await page.getByRole("button", { name: "새로고침" }).click();
    await page.waitForTimeout(1200);
    check(
      "등록된 라인 목록에 노출 (유닛 링크 컬럼)",
      await page.getByRole("cell", { name: unitText }).isVisible(),
    );
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill("초기화 테스트");
    await page.getByLabel("소속 허브").selectOption("career");
    await page.getByLabel("유닛 링크").fill("초기화될 텍스트");
    await page.getByRole("button", { name: "초기화" }).click();
    check("초기화: 라인명 비움", (await page.getByPlaceholder("예) 마케팅 전략 라인").inputValue()) === "");
    check("초기화: 허브 '-' 복귀", (await page.getByLabel("소속 허브").inputValue()) === "-");
    check("초기화: 유닛 링크 비움", (await page.getByLabel("유닛 링크").inputValue()) === "");
    await page.screenshot({ path: "claudedocs/browser-line-register-v2-final.png", fullPage: true });

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
