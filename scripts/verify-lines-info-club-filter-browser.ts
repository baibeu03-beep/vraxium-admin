/**
 * 브라우저 E2E: /admin/lines/info 적용 클럽 필터 = 화면 표시값 정합 (2026-06-14).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-club-filter-browser.ts
 * READ-ONLY. 스크린샷: claudedocs/browser-lines-info-club-filter.png
 *
 * 검증: 각 옵션(공통/encre/oranke/phalanx) 선택 시, 보이는 모든 행의 적용 클럽 셀이
 *       선택값과 동일한지 (페이지네이션 모든 페이지 순회).
 */
import { chromium, type Page } from "playwright-core";
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

// 현재 필터 상태에서 모든 페이지를 순회하며 적용 클럽(2번째 컬럼) 셀 값을 수집한다.
async function collectAllClubCells(page: Page): Promise<string[]> {
  const all: string[] = [];
  // 페이지 버튼: aria-label="N페이지". 없으면 단일 페이지.
  const pageButtons = page.getByRole("button", { name: /^\d+페이지$/ });
  const n = await pageButtons.count();
  const total = Math.max(1, n);
  for (let p = 1; p <= total; p++) {
    if (n > 0) {
      await page.getByRole("button", { name: `${p}페이지`, exact: true }).click();
      await page.waitForTimeout(200);
    }
    const cells = await page.locator("tbody tr td:nth-child(2)").allTextContents();
    all.push(...cells.map((c) => c.trim()));
  }
  return all;
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
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=등록된 라인", { timeout: 20000 });

    console.log("=== A) 적용 클럽 필터 옵션 구성 (요구사항 2·3) ===");
    const optionTexts = await page
      .getByLabel("적용 클럽 필터")
      .locator("option")
      .allTextContents();
    check(
      "옵션 = 전체 · 공통 · encre · oranke · phalanx (common→'공통' 표기)",
      JSON.stringify(optionTexts.map((t) => t.trim())) ===
        JSON.stringify(["전체", "공통", "encre", "oranke", "phalanx"]),
      optionTexts.join(" | "),
    );

    console.log("\n=== B) 옵션별 필터 = 보이는 셀 전부 동일값 (요구사항 4·5) ===");
    for (const opt of ["공통", "encre", "oranke", "phalanx"]) {
      await page.getByLabel("적용 클럽 필터").selectOption({ label: opt });
      await page.waitForTimeout(300);
      const cells = await collectAllClubCells(page);
      check(
        `필터 "${opt}" — 전 페이지 셀(${cells.length}건) 전부 "${opt}"`,
        cells.length > 0 && cells.every((c) => c === opt),
        `고유값: ${[...new Set(cells)].join(", ")}`,
      );
    }

    console.log("\n=== C) 스크린샷 (공통 필터 적용 상태) ===");
    await page.getByLabel("적용 클럽 필터").selectOption({ label: "공통" });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: "claudedocs/browser-lines-info-club-filter.png",
      fullPage: true,
    });
    console.log("  스크린샷: claudedocs/browser-lines-info-club-filter.png");

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
