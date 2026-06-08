/**
 * 브라우저 E2E 검증: /admin/lines/info 라인 정보 (Phase 2B, read-only 통합 조회).
 *   npx tsx --env-file=.env.local scripts/verify-line-catalog-browser.ts
 * READ-ONLY. 스크린샷: claudedocs/browser-line-info-catalog.png
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

    console.log("=== A) 렌더 + 원천 4종 건수 ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=통합 라인 목록", { timeout: 15000 });
    check(
      "페이지 타이틀 '라인 정보'",
      await page.getByRole("heading", { name: "라인 정보", exact: true }).isVisible(),
    );
    const desc = await page.getByText(/경험 마스터 \d+ · 역량 마스터 \d+/).textContent();
    check(
      "원천별 건수 노출 (경험 26·역량 30·경력 1)",
      Boolean(desc?.includes("경험 마스터 26") && desc?.includes("역량 마스터 30") && desc?.includes("경력 마스터 1")),
      desc ?? "",
    );
    const rowCount = await page.locator("tbody tr").count();
    check("통합 행 수 = 전체 건수", Boolean(desc && rowCount > 0 && desc.includes(`표시 ${rowCount}건`)), `rows=${rowCount}`);
    check("출처 뱃지 '경험 마스터' 노출", (await page.getByRole("cell", { name: "경험 마스터" }).count()) > 0);
    check("출처 뱃지 '신규 등록' 노출", (await page.getByRole("cell", { name: "신규 등록" }).count()) > 0);
    await page.screenshot({ path: "claudedocs/browser-line-info-catalog.png", fullPage: true });

    console.log("\n=== B) 필터 ===");
    await page.getByLabel("허브 필터").selectOption("competency");
    await page.waitForTimeout(300);
    const compRows = await page.locator("tbody tr").count();
    const compCells = await page.locator("tbody tr td:nth-child(2)").allTextContents();
    // 2D 백필 후: 역량 = 마스터 30 + 이관 등록 30 = 60행 (전부 '실무 역량').
    check(
      "허브=실무 역량 필터 — 역량 행만 60건(마스터30+이관30)",
      compRows === 60 && compCells.every((t) => t === "실무 역량"),
      `rows=${compRows}`,
    );
    await page.getByLabel("허브 필터").selectOption("all");
    await page.getByLabel("데이터 출처 필터").selectOption("registration");
    await page.waitForTimeout(300);
    const regCells = await page.locator("tbody tr td:nth-child(7)").allTextContents();
    check(
      "출처=신규 등록 필터 — 등록 행만",
      regCells.length > 0 && regCells.every((t) => t.trim() === "신규 등록"),
      `rows=${regCells.length}`,
    );
    await page.getByLabel("데이터 출처 필터").selectOption("all");
    await page.getByLabel("라인 검색").fill("EXBS");
    await page.waitForTimeout(400);
    const searchCodes = await page.locator("tbody tr td:nth-child(4)").allTextContents();
    check(
      "검색 'EXBS' — 코드 매칭 행만",
      searchCodes.length > 0 && searchCodes.every((t) => t.includes("EXBS")),
      `rows=${searchCodes.length}`,
    );
    await page.getByLabel("라인 검색").fill("");

    console.log("\n=== C) 정렬 ===");
    await page.getByLabel("정렬").selectOption("oldest");
    await page.waitForTimeout(300);
    const firstOld = await page.locator("tbody tr td:nth-child(1)").first().textContent();
    await page.getByLabel("정렬").selectOption("latest");
    await page.waitForTimeout(300);
    const firstNew = await page.locator("tbody tr td:nth-child(1)").first().textContent();
    check("정렬 전환 시 첫 행 변경", firstOld !== firstNew, `oldest첫='${firstOld?.trim()}' latest첫='${firstNew?.trim()}'`);

    console.log("\n=== D) read-only — 액션 버튼 부재 ===");
    const actionButtons = await page
      .locator("tbody")
      .getByRole("button")
      .count();
    check("행 내 개설/수정/삭제 버튼 0개", actionButtons === 0, `buttons=${actionButtons}`);

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
