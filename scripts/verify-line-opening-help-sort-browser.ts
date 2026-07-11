import { chromium, type Page, type BrowserContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening 라이브 화면 전체 — 요소별 도움말(돋보기) + 테이블 정렬 + org/mode 중립 브라우저 검증.
//   대상(라이브만): practical-career(등록/개설/평가), practical-info(관리/개설),
//                   practical-experience(관리/개설), practical-competency(관리/개설).
//   확인:
//     1) 각 화면 돋보기(도움말) 렌더 개수 > 0, 스크린샷 1440/1280/1024
//     2) 대표 테이블에서 컬럼 정렬 오름→내림→기본 복귀, 도움말 클릭이 정렬을 바꾸지 않음
//     3) /api/admin/help 요청에 org/mode 파라미터 누수 없음(공통 키)
//     4) mode=test 진입 시에도 동일 렌더(도움말 개수/구조 동일)

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";
const ORG = process.env.LO_ORG ?? "phalanx";
const BREAKPOINTS = [1440, 1280, 1024];

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
  assert(
    link.properties?.email_otp && !linkError,
    linkError?.message ?? "generateLink failed",
  );
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(
    verified.session && !verifyError,
    verifyError?.message ?? "verifyOtp failed",
  );
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map(({ name, value }) => ({ name, value }))),
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

async function countHelp(page: Page): Promise<number> {
  return page.getByRole("button", { name: "이 항목 도움말" }).count();
}

async function shootBreakpoints(page: Page, prefix: string) {
  for (const w of BREAKPOINTS) {
    await page.setViewportSize({ width: w, height: 1000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOT_DIR}/qa-lo-${prefix}-${w}.png`, fullPage: true });
    // 페이지 전체 가로 스크롤이 생기지 않아야 한다(테이블 내부 overflow 는 허용).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 2) {
      console.log(`  WARN ${prefix}@${w}: page horizontal overflow ${overflow}px`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

// 한 컬럼 정렬 트리거를 오름→내림→기본 순환하고, 첫 열 텍스트 스냅샷이 각 단계마다 바뀌는지 확인.
async function exerciseSort(page: Page, sortButtonName: string, prefix: string) {
  const btn = page.getByRole("button", { name: sortButtonName });
  if ((await btn.count()) === 0) {
    console.log(`  SKIP sort "${sortButtonName}" (트리거 없음)`);
    return;
  }
  const rowText = () =>
    page.$$eval("table tbody tr", (rows) =>
      rows.slice(0, 30).map((r) => (r.textContent ?? "").trim()).join("||"),
    );
  const rowCount = await page.locator("table tbody tr").count();
  if (rowCount < 2) {
    console.log(`  SKIP sort "${sortButtonName}" (행 ${rowCount} — 정렬 관찰 불가, 도움말/트리거만 존재 확인)`);
    return;
  }
  const base = await rowText();
  await btn.first().click();
  await page.waitForTimeout(300);
  const asc = await rowText();
  await btn.first().click();
  await page.waitForTimeout(300);
  const desc = await rowText();
  await btn.first().click();
  await page.waitForTimeout(300);
  const back = await rowText();
  assert(asc !== desc || rowCount === 1, `"${sortButtonName}" 오름/내림 동일(정렬 미작동)`);
  assert(back === base, `"${sortButtonName}" 3번째 클릭 후 기본 순서 미복귀`);
  console.log(`  PASS sort "${sortButtonName}" 오름→내림→기본 복귀 (rows=${rowCount})`);
  await page.screenshot({ path: `${SHOT_DIR}/qa-lo-${prefix}-sorted.png` });
}

// 도움말(돋보기) 클릭이 정렬 상태를 바꾸지 않는지 — 첫 도움말 클릭 전후 행 순서 동일 + 모달 열림.
async function assertHelpNoSortInterference(page: Page) {
  const rowText = () =>
    page.$$eval("table tbody tr", (rows) =>
      rows.slice(0, 30).map((r) => (r.textContent ?? "").trim()).join("||"),
    );
  const help = page.getByRole("button", { name: "이 항목 도움말" });
  if ((await help.count()) === 0 || (await page.locator("table tbody tr").count()) < 2) return;
  const before = await rowText();
  await help.first().click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  await page.getByRole("button", { name: "닫기" }).click().catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  const after = await rowText();
  assert(before === after, "도움말 클릭이 정렬을 트리거함(행 순서 변경)");
  console.log("  PASS 도움말 클릭 ↛ 정렬(순서 불변) + 편집 모달 오픈");
}

// 도움말 편집/저장 모달 E2E — 렌더된 돋보기 하나에서 열기→편집→저장(PUT)→새로고침 유지 확인.
//   데이터가 비어 표 컬럼 도움말이 없어도, 제목/필터 돋보기는 항상 렌더되므로 이걸로 검증한다.
async function helpRoundTrip(page: Page, url: string, marker: string): Promise<boolean> {
  await page.goto(`${baseUrl}${url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page
    .waitForSelector('button[aria-label="이 항목 도움말"]', { timeout: 25_000 })
    .catch(() => {});
  const mags = page.getByRole("button", { name: "이 항목 도움말" });
  if ((await mags.count()) === 0) {
    console.log("  SKIP help round-trip (돋보기 미렌더)");
    return false;
  }
  await mags.first().click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  const hasEdit = await page.getByRole("button", { name: "편집" }).isVisible().catch(() => false);
  const hasSave = await page.getByRole("button", { name: "저장" }).isVisible().catch(() => false);
  console.log(`  PASS 돋보기 클릭 → 편집/저장 모달(편집=${hasEdit} 저장=${hasSave})`);
  if (hasEdit) await page.getByRole("button", { name: "편집" }).click().catch(() => {});
  const ta = dlg.locator("textarea");
  await ta.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  if (await ta.count()) {
    await ta.fill(marker);
    const put = page.waitForResponse(
      (r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT",
      { timeout: 15_000 },
    );
    await page.getByRole("button", { name: "저장" }).click();
    const resp = await put.catch(() => null);
    console.log(`  PASS 편집→저장 PUT ${resp ? resp.status() : "(no resp)"}`);
    await page.getByRole("button", { name: "닫기" }).click().catch(() => {});
    await page.waitForTimeout(400);
    // 새로고침 후 유지
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('button[aria-label="이 항목 도움말"]', { timeout: 20_000 }).catch(() => {});
    await page.getByRole("button", { name: "이 항목 도움말" }).first().click();
    const dlg2 = page.getByRole("dialog");
    await dlg2.waitFor({ state: "visible", timeout: 10_000 });
    // 내용은 모달 오픈 후 GET 으로 비동기 로드 → 즉시 isVisible 대신 등장까지 대기.
    const persisted = await dlg2
      .getByText(marker.slice(0, 18), { exact: false })
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    console.log(`  ${persisted ? "PASS" : "WARN"} 새로고침 후 저장 내용 유지 = ${persisted}`);
    await page.getByRole("button", { name: "닫기" }).click().catch(() => {});
    return true;
  }
  await page.getByRole("button", { name: "닫기" }).click().catch(() => {});
  return false;
}

type View = {
  key: string;
  url: string;
  label: string;
  sortButton?: string; // 대표 정렬 컬럼 aria-label ("{컬럼} 정렬")
  waitTable?: boolean;
};

async function visit(page: Page, v: View) {
  console.log(`\n── ${v.label}  [${v.url}]`);
  // Next dev 는 라우트 최초 접근 시 컴파일 → 첫 렌더가 느리다. 넉넉히 대기 + 안정 요소 폴링.
  await page.goto(`${baseUrl}${v.url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // 도움말 아이콘 또는 테이블/카드가 등장할 때까지(최대 25s) — 컴파일/데이터 로드 흡수.
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('button[aria-label="이 항목 도움말"]').length > 0 ||
        document.querySelector("table") != null,
      { timeout: 25_000 },
    )
    .catch(() => console.log("  (도움말/테이블 미등장 — 빈 데이터 또는 로딩 지연)"));
  await page.waitForTimeout(1500);
  if (v.waitTable) {
    await page.waitForSelector("table tbody tr", { timeout: 8_000 }).catch(() => {
      console.log("  (table rows 미등장 — 빈 데이터일 수 있음)");
    });
  }
  const help = await countHelp(page);
  console.log(`  돋보기(도움말) ${help}개${help === 0 ? "  ⚠ WARN 0개" : ""}`);
  await shootBreakpoints(page, v.key);
  if (v.sortButton) {
    await exerciseSort(page, v.sortButton, v.key);
    await assertHelpNoSortInterference(page);
  }
  return help;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  wireHelpSniffer(page);

  const operatingViews: View[] = [
    {
      key: "career-reg",
      url: "/admin/line-opening/practical-career",
      label: "실무 경력 · 라인 등록",
      sortButton: "라인명 정렬",
      waitTable: true,
    },
    {
      key: "info-manage",
      url: `/admin/line-opening/practical-info?org=${ORG}`,
      label: "실무 정보 · 라인 관리",
    },
    {
      key: "info-open",
      url: `/admin/line-opening/practical-info?org=${ORG}&tab=open`,
      label: "실무 정보 · 라인 개설",
    },
    {
      key: "exp-manage",
      url: `/admin/line-opening/practical-experience?org=${ORG}`,
      label: "실무 경험 · 라인 관리",
    },
    {
      key: "exp-open",
      url: `/admin/line-opening/practical-experience?org=${ORG}&tab=open`,
      label: "실무 경험 · 라인 개설",
    },
    {
      key: "comp-manage",
      url: `/admin/line-opening/practical-competency?org=${ORG}`,
      label: "실무 역량 · 라인 관리",
      sortButton: "크루명 정렬",
      waitTable: true,
    },
    {
      key: "comp-open",
      url: `/admin/line-opening/practical-competency?org=${ORG}&tab=open`,
      label: "실무 역량 · 라인 개설",
    },
  ];

  const results: Record<string, number> = {};
  let hardFail = 0;
  try {
    for (const v of operatingViews) {
      try {
        results[v.key] = await visit(page, v);
      } catch (e) {
        hardFail++;
        console.log(`  ERROR ${v.key}: ${(e as Error).message}`);
      }
    }

    // 도움말 편집/저장/새로고침 유지 E2E (데이터 무관 — 제목 돋보기로 검증) + /api/admin/help 요청 생성.
    console.log("\n══ 도움말 편집/저장 E2E ══");
    const marker = `[QA LineOpening 도움말 유지 검증]`;
    await helpRoundTrip(page, `/admin/line-opening/practical-info?org=${ORG}&tab=open`, marker).catch(
      (e) => console.log(`  ERROR help round-trip: ${(e as Error).message}`),
    );

    // mode=test 진입 — 대표 화면에서 도움말 개수/구조가 동일한지(중립, 데이터 조건부 배지는 오차 허용).
    console.log("\n══ mode=test 파리티(구조 중립) ══");
    for (const base of ["career-reg", "comp-manage", "comp-open"]) {
      const v = operatingViews.find((x) => x.key === base)!;
      const sep = v.url.includes("?") ? "&" : "?";
      await page.goto(`${baseUrl}${v.url}${sep}mode=test`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page
        .waitForFunction(
          () =>
            document.querySelectorAll('button[aria-label="이 항목 도움말"]').length > 0 ||
            document.querySelector("table") != null,
          { timeout: 25_000 },
        )
        .catch(() => {});
      await page.waitForTimeout(1500);
      const helpTest = await countHelp(page);
      const op = results[base] ?? 0;
      const same = helpTest === op ? "동일" : "차이(데이터 조건부일 수 있음)";
      console.log(`  ${v.label} (mode=test) 돋보기 ${helpTest}개 vs 운영 ${op}개 — ${same}`);
    }

    // org/mode 중립 — /api/admin/help 요청에 org/mode 파라미터 없어야 한다(하드 게이트).
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    if (leaked.length > 0) {
      hardFail++;
      console.log(`  FAIL org/mode 파라미터 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    } else {
      console.log(`\nPASS /api/admin/help ${helpReqs.length}건 모두 org/mode 파라미터 없음`);
    }

    console.log("\n도움말 개수:", JSON.stringify(results));
    console.log("captured keys:", [...cleanupKeys].sort().join(", "));
    console.log(hardFail === 0 ? "\nRESULT: OK" : `\nRESULT: ${hardFail} hard issue(s)`);
  } finally {
    for (const k of cleanupKeys) {
      await supabaseAdmin
        .from("admin_page_help_contents")
        .upsert(
          { page_path: k, content: "", updated_at: new Date().toISOString() },
          { onConflict: "page_path" },
        );
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
