/**
 * 브라우저 E2E 검증: /admin/lines/info — line_registrations 전용 테이블 (2026-06-07 개정).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-registrations-browser.ts
 * READ-ONLY. 스크린샷: claudedocs/browser-lines-info-registrations.png
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

    console.log("=== A) 렌더 + 컬럼 구성 (검증 항목 1) ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=등록된 라인", { timeout: 20000 });
    check(
      "페이지 타이틀 '라인 정보'",
      await page.getByRole("heading", { name: "라인 정보", exact: true }).isVisible(),
    );
    const headers = await page.locator("thead th").allTextContents();
    const expected = [
      "라인명", "적용 클럽", "소속 허브", "라인 종류", "라인 코드",
      "메인 타이틀 종류", "메인 타이틀", "유닛 링크", "상태", "개설 연결", "관리",
    ];
    check(
      "헤더 11컬럼 정확히 일치 (요청 8 + 상태/개설 연결/관리)",
      JSON.stringify(headers) === JSON.stringify(expected),
      headers.join(" | "),
    );
    const rowCount = await page.locator("tbody tr").count();
    check("행 렌더 (>0)", rowCount > 0, `rows=${rowCount}`);

    console.log("\n=== B) 적용 클럽 = organization_slug (검증 항목 2) ===");
    const orgCells = await page.locator("tbody tr td:nth-child(2)").allTextContents();
    check(
      "적용 클럽 셀 — slug 원문(encre/oranke/phalanx/common) 또는 '-'",
      orgCells.length > 0 &&
        orgCells.every((t) => ["encre", "oranke", "phalanx", "common", "-"].includes(t.trim())),
      `예: ${[...new Set(orgCells.map((t) => t.trim()))].join(", ")}`,
    );

    console.log("\n=== C) 메인 타이틀 종류 — 허브 정책 (검증 항목 3·4) ===");
    // 행 단위로 (허브, 종류, 타이틀) 트리플 수집
    const triples = await page.locator("tbody tr").evaluateAll((trs) =>
      trs.map((tr) => {
        const tds = tr.querySelectorAll("td");
        return {
          hub: tds[2]?.textContent?.trim() ?? "",
          mode: tds[5]?.textContent?.trim() ?? "",
          title: tds[6]?.textContent?.trim() ?? "",
        };
      }),
    );
    const fixedHubRows = triples.filter((t) => t.hub === "실무 경험" || t.hub === "실무 역량");
    const variableHubRows = triples.filter((t) => t.hub === "실무 정보" || t.hub === "실무 경력");
    check(
      `실무 경험/역량 행(${fixedHubRows.length}건) — 전부 '고정' + 타이틀 표시`,
      fixedHubRows.length > 0 &&
        fixedHubRows.every((t) => t.mode === "고정" && t.title !== "-" && t.title.length > 0),
    );
    check(
      `실무 정보/경력 행(${variableHubRows.length}건) — 전부 '변동' + 타이틀 '-'`,
      variableHubRows.every((t) => t.mode === "변동" && t.title === "-"),
      variableHubRows.length === 0 ? "해당 행 0건 (스킵 아님 — 전건 만족)" : undefined,
    );

    console.log("\n=== D) 유닛 링크 (검증 항목 5) ===");
    const unitCells = await page.locator("tbody tr td:nth-child(8)").allTextContents();
    check(
      "유닛 링크 셀 — 전부 비공백 (미입력 '-')",
      unitCells.length > 0 && unitCells.every((t) => t.trim().length > 0),
      `예: ${[...new Set(unitCells.map((t) => t.trim()))].slice(0, 3).join(", ")}`,
    );

    console.log("\n=== E) 기능 유지 — 상태/개설 연결/관리 ===");
    const statusBadges = await page.locator("tbody tr td:nth-child(9)").allTextContents();
    check(
      "상태 뱃지 활성/비활성",
      statusBadges.every((t) => t.trim() === "활성" || t.trim() === "비활성"),
    );
    const editButtons = await page
      .locator("tbody")
      .getByRole("button", { name: "수정" })
      .count();
    check("수정 버튼 = 행 수", editButtons === rowCount, `buttons=${editButtons}`);
    const bridgeCells = await page.locator("tbody tr td:nth-child(10)").allTextContents();
    check(
      "개설 연결 컬럼 — 연결됨/개설 연결/조직 미지정/프리필 중 하나",
      bridgeCells.every((t) =>
        ["연결됨", "개설 연결", "조직 미지정", "개설 화면(프리필)"].some((k) =>
          t.trim().includes(k),
        ),
      ),
      `예: ${[...new Set(bridgeCells.map((t) => t.trim()))].join(", ")}`,
    );

    console.log("\n=== F) 필터/검색 동작 ===");
    await page.getByLabel("허브 필터").selectOption("competency");
    await page.waitForTimeout(300);
    const compHubs = await page.locator("tbody tr td:nth-child(3)").allTextContents();
    check(
      "허브=실무 역량 필터",
      compHubs.length > 0 && compHubs.every((t) => t.trim() === "실무 역량"),
      `rows=${compHubs.length}`,
    );
    await page.getByLabel("허브 필터").selectOption("all");
    await page.getByLabel("라인 검색").fill("EXBS");
    await page.waitForTimeout(400);
    const searchCodes = await page.locator("tbody tr td:nth-child(5)").allTextContents();
    check(
      "검색 'EXBS' — 코드 매칭 행만",
      searchCodes.length > 0 && searchCodes.every((t) => t.includes("EXBS")),
      `rows=${searchCodes.length}`,
    );
    await page.getByLabel("라인 검색").fill("");
    await page.waitForTimeout(300);

    console.log("\n=== G) 수정 모달 열림/닫힘 (read-only — 저장 안 함) ===");
    await page.locator("tbody").getByRole("button", { name: "수정" }).first().click();
    await page.waitForSelector("text=등록 수정", { timeout: 10000 });
    check("수정 모달 열림", await page.getByText("등록 수정").isVisible());
    await page.getByRole("button", { name: "취소" }).click();
    await page.waitForTimeout(200);
    check("수정 모달 닫힘 (저장 없음)", (await page.getByText("등록 수정").count()) === 0);

    await page.screenshot({
      path: "claudedocs/browser-lines-info-registrations.png",
      fullPage: true,
    });
    console.log("\n스크린샷: claudedocs/browser-lines-info-registrations.png");

    console.log("\n=== H) /admin/lines/register — 하단 테이블 제거 확인 ===");
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=라인 등록", { timeout: 20000 });
    check(
      "register 페이지에 '등록된 라인' 카드 없음",
      (await page.getByText("등록된 라인", { exact: true }).count()) === 0,
    );
    check(
      "register 페이지에 테이블 없음 (등록 폼만)",
      (await page.locator("table").count()) === 0,
    );
    await page.screenshot({
      path: "claudedocs/browser-lines-register-form-only.png",
      fullPage: true,
    });

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
