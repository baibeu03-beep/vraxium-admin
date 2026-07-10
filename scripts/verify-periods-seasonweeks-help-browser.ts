import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/periods/register + /admin/season-weeks 요소별 도움말(돋보기) & 테이블 정렬 브라우저 검증.
//   A) periods/register: 돋보기 9개 렌더 · 클릭→편집/저장 모달 · 저장→새로고침 유지
//   B) season-weeks: 필터 4 + 컬럼 7 도움말 렌더 · 컬럼 정렬 오름/내림/기본 복귀 · 도움말≠정렬 간섭
//   C) /api/admin/help 요청에 org/mode 파라미터 없음(공통 키)

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (adminError) throw adminError;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

type HelpReq = { method: string; path: string | null; mode: string | null; org: string | null };
const helpReqs: HelpReq[] = [];
const cleanupKeys = new Set<string>();

function wireHelpSniffer(page: Page) {
  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname !== "/api/admin/help") return;
    let path = u.searchParams.get("path");
    if (!path && request.postData()) {
      try {
        path = (JSON.parse(request.postData()!) as { path?: string }).path ?? null;
      } catch {
        /* ignore */
      }
    }
    if (path) cleanupKeys.add(path);
    helpReqs.push({
      method: request.method(),
      path,
      mode: u.searchParams.get("mode"),
      org: u.searchParams.get("org"),
    });
  });
}

// 컬럼 헤더의 첫 <th> 안의 정렬 트리거 텍스트(컬럼명)로 정렬 방향 아이콘 상태를 반환.
async function headYear(page: Page): Promise<number[]> {
  // "년도" 컬럼 셀 값(예: "2026년")을 위→아래 순서로 숫자 배열로 반환.
  return page.$$eval("table tbody tr td:nth-child(3)", (cells) =>
    cells.map((c) => {
      const m = (c.textContent ?? "").match(/(\d{4})/);
      return m ? Number(m[1]) : Number.NaN;
    }),
  );
}

function isSortedAsc(nums: number[]): boolean {
  const v = nums.filter((n) => !Number.isNaN(n));
  return v.every((n, i) => i === 0 || v[i - 1] <= n);
}
function isSortedDesc(nums: number[]): boolean {
  const v = nums.filter((n) => !Number.isNaN(n));
  return v.every((n, i) => i === 0 || v[i - 1] >= n);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  wireHelpSniffer(page);

  const marker = `[QA ${new Date().toISOString()}] 기간등록 도움말 유지 검증`;

  try {
    // ══ A) /admin/periods/register ═══════════════════════════════════════════
    await page.goto(`${baseUrl}/admin/periods/register`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const magsA = page.getByRole("button", { name: "이 항목 도움말" });
    const countA = await magsA.count();
    assert(countA === 9, `periods/register 돋보기 9개 기대, 실제 ${countA}`);
    console.log(`PASS A1 periods/register 돋보기 ${countA}개 렌더`);
    await page.screenshot({ path: `${SHOT_DIR}/qa-periods-register-help.png`, fullPage: true });

    // 클릭 → 편집/저장 모달
    await magsA.nth(0).click();
    const dlgA = page.getByRole("dialog");
    await dlgA.waitFor({ state: "visible", timeout: 10_000 });
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "[편집] 버튼 없음");
    assert(await page.getByRole("button", { name: "저장" }).isVisible(), "[저장] 버튼 없음");
    console.log("PASS A2 돋보기 클릭 → 편집/저장 모달");

    // 편집 → 저장
    await page.getByRole("button", { name: "편집" }).click();
    const taA = dlgA.locator("textarea");
    await taA.waitFor({ state: "visible" });
    await taA.fill(marker);
    const putA = page.waitForResponse(
      (r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "저장" }).click();
    const putRespA = await putA;
    assert(putRespA.ok(), `periods 저장 PUT 실패 ${putRespA.status()}`);
    console.log("PASS A3 편집→저장 PUT 200");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    // 새로고침 후 유지
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "이 항목 도움말" }).nth(0).click();
    const dlgA2 = page.getByRole("dialog");
    await dlgA2.waitFor({ state: "visible", timeout: 10_000 });
    await dlgA2.getByText(marker.slice(0, 20), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS A4 새로고침 후 저장 내용 유지");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    // ══ B) /admin/season-weeks ═══════════════════════════════════════════════
    await page.goto(`${baseUrl}/admin/season-weeks`, { waitUntil: "domcontentloaded" });
    // 데이터 로드 대기(테이블 행 등장까지).
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });
    await page.waitForTimeout(500);
    const magsB = page.getByRole("button", { name: "이 항목 도움말" });
    const countB = await magsB.count();
    // 필터 4(정렬/년도/시즌/활동) + 새로고침 1 + 초기화 1 + 컬럼 7 = 13
    assert(countB === 13, `season-weeks 돋보기 13개 기대(필터4+버튼2+컬럼7), 실제 ${countB}`);
    console.log(`PASS B1 season-weeks 돋보기 ${countB}개 렌더(필터4+버튼2+컬럼7)`);
    await page.screenshot({ path: `${SHOT_DIR}/qa-season-weeks-help.png`, fullPage: true });

    // 컬럼 헤더 도움말 클릭 → 모달 (정렬 트리거와 간섭 없음: 클릭 전후 년도 순서 동일)
    const before = await headYear(page);
    const yearHeadHelp = page
      .locator("thead th")
      .filter({ hasText: "년도" })
      .getByRole("button", { name: "이 항목 도움말" });
    await yearHeadHelp.click();
    const dlgB = page.getByRole("dialog");
    await dlgB.waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS B2 컬럼 헤더 돋보기 → 편집 모달");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);
    const afterHelp = await headYear(page);
    assert(
      JSON.stringify(before) === JSON.stringify(afterHelp),
      "도움말 클릭이 정렬을 트리거함(년도 순서 변경됨)",
    );
    console.log("PASS B3 도움말 클릭이 정렬을 트리거하지 않음(순서 불변)");

    // 정렬 사이클: 년도 컬럼명 클릭 → asc → desc → 기본
    const yearSortBtn = page.getByRole("button", { name: "년도 정렬" });

    await yearSortBtn.click();
    await page.waitForTimeout(300);
    const asc = await headYear(page);
    assert(isSortedAsc(asc), `1차 클릭 오름차순 실패: ${asc.join(",")}`);
    console.log("PASS B4 1차 클릭 = 오름차순");
    await page.screenshot({ path: `${SHOT_DIR}/qa-season-weeks-sort-asc.png` });

    await yearSortBtn.click();
    await page.waitForTimeout(300);
    const desc = await headYear(page);
    assert(isSortedDesc(desc), `2차 클릭 내림차순 실패: ${desc.join(",")}`);
    console.log("PASS B5 2차 클릭 = 내림차순");
    await page.screenshot({ path: `${SHOT_DIR}/qa-season-weeks-sort-desc.png` });

    await yearSortBtn.click();
    await page.waitForTimeout(300);
    const back = await headYear(page);
    // 기본 순서 = 최신 순(week_start_date desc) → 년도도 대체로 내림차순이지만,
    // 핵심은 "컬럼 정렬 asc 상태(back≠asc)가 해제됐는지"다.
    assert(
      JSON.stringify(back) !== JSON.stringify(asc),
      "3차 클릭 후에도 오름차순 유지 — 기본 복귀 실패",
    );
    console.log("PASS B6 3차 클릭 = 기본 순서 복귀(오름차순 해제)");

    // 문자열 컬럼(비고) locale-aware 정렬도 클릭 동작 확인(에러 없이 순환).
    const remarkSortBtn = page.getByRole("button", { name: "비고 정렬" });
    await remarkSortBtn.click();
    await page.waitForTimeout(250);
    await remarkSortBtn.click();
    await page.waitForTimeout(250);
    await remarkSortBtn.click();
    await page.waitForTimeout(250);
    console.log("PASS B7 문자열 컬럼(비고) 정렬 순환 정상");

    // ══ C) org/mode 중립 ══════════════════════════════════════════════════════
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `org/mode 파라미터 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS C /api/admin/help ${helpReqs.length}건 모두 org/mode 파라미터 없음`);

    console.log("\nALL PASS");
    console.log("captured keys:", [...cleanupKeys].sort().join(", "));
  } finally {
    // 검증용 저장 내용 정리(빈 문자열 upsert).
    for (const k of cleanupKeys) {
      await supabaseAdmin
        .from("admin_page_help_contents")
        .upsert({ page_path: k, content: "", updated_at: new Date().toISOString() }, { onConflict: "page_path" });
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
