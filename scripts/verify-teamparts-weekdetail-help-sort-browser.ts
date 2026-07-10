import { chromium, type APIRequestContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/team-parts/info/weeks/[weekId] (활동 관리 상세) — 돋보기/정렬/커서/파리티 검증.
//   HTTP: 일반 vs mode=test 동일 DTO(detail·line-opening·act-check) + createdAtIso 필드 존재.
//   Browser: 돋보기 렌더/저장·유지/클릭≠정렬, LineOpeningTable 3단계 정렬+aria-sort,
//            act-check 라인급 정렬, 커서 pointer, 1440/1280/1024 body 무스크롤.

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";
const CLUB = "encre";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !le, le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  assert(v.session && !ve, ve?.message ?? "verifyOtp failed");
  const cap: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map(({ name, value }) => ({ name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function getJson(api: APIRequestContext, url: string) {
  const r = await api.get(url);
  assert(r.ok(), `API 실패 ${r.status()} ${url}`);
  return (await r.json()) as { data: Record<string, unknown> };
}
const keys = (o: unknown) => Object.keys((o ?? {}) as object).sort().join(",");

async function main() {
  const marker = `[QA-WD ${new Date().toISOString()}] lineName 컬럼 저장 검증`;
  const cleanupKeys = ["admin.teamParts.info.weeks.activity.lineOpening.column.lineName"];
  const helpReqs: Array<{ mode: string | null; org: string | null }> = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.addCookies(await makeAdminCookies());
  const api = context.request;

  try {
    // weekId 선택 — 공식 활동 주차 1개(라인 카탈로그는 항상 존재).
    const weeksJson = await getJson(api, `${baseUrl}/api/admin/team-parts/info/weeks?club=${CLUB}&page=1&pageSize=100`);
    const items = weeksJson.data.items as Array<{ weekId: string; clubActivityStatus: string }>;
    const target = items.find((w) => w.clubActivityStatus === "official_activity") ?? items[0];
    assert(target, "대상 주차를 찾지 못함");
    const weekId = target.weekId;
    console.log(`PASS 대상 주차 선택 — ${weekId}`);

    // HTTP 파리티: detail·line·act (일반 vs test) 동일 DTO 키
    for (const path of ["", "/line-opening-management", "/act-check-management"]) {
      const n = await getJson(api, `${baseUrl}/api/admin/team-parts/info/weeks/${weekId}${path}?club=${CLUB}`);
      const t = await getJson(api, `${baseUrl}/api/admin/team-parts/info/weeks/${weekId}${path}?club=${CLUB}&mode=test`);
      assert(keys(n.data) === keys(t.data), `일반/test DTO 키 불일치 (${path || "detail"})\n${keys(n.data)}\n${keys(t.data)}`);
    }
    console.log("PASS HTTP 파리티 — detail·line-opening·act-check 일반/test 동일 DTO 키");

    // createdAtIso 필드 존재(정렬용 실제 값)
    const lineJson = await getJson(api, `${baseUrl}/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?club=${CLUB}`);
    const infoLines = (lineJson.data.practicalInfo as { lines: Array<Record<string, unknown>> }).lines;
    assert(infoLines.length > 0, "실무 정보 라인 없음(정렬 검증 불가)");
    assert("createdAtIso" in infoLines[0], "createdAtIso 필드 없음(정렬용 실제 값)");
    console.log(`PASS createdAtIso 필드 존재 — 실무 정보 라인 ${infoLines.length}개`);

    // ── Browser ──
    const page = await context.newPage();
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.pathname === "/api/admin/help") helpReqs.push({ mode: u.searchParams.get("mode"), org: u.searchParams.get("org") });
    });
    const detailUrl = `${baseUrl}/admin/team-parts/info/weeks/${weekId}?club=${CLUB}`;
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-managed-week]", { timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label="이 항목 도움말"]').length >= 15,
      { timeout: 20_000 },
    );
    const magCount = await page.getByRole("button", { name: "이 항목 도움말" }).count();
    console.log(`PASS 돋보기 렌더(액트 탭) — ${magCount}개`);

    // 레이아웃 — body 가로 스크롤 없음
    for (const w of [1440, 1280, 1024] as const) {
      await page.setViewportSize({ width: w, height: 1200 });
      await page.waitForTimeout(400);
      const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      assert(ok, `body 가로 스크롤 발생 @${w}px`);
      await page.screenshot({ path: `${SHOT_DIR}/qa-wd-${w}.png` });
      console.log(`PASS 레이아웃 @${w}px — body 가로 스크롤 없음 (qa-wd-${w}.png)`);
    }
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.waitForTimeout(300);

    // 커서 pointer — 탭 버튼
    const tabCursor = await page.locator('[data-tab="line"]').evaluate((el) => getComputedStyle(el).cursor);
    assert(tabCursor === "pointer", `탭 커서가 pointer 아님(${tabCursor})`);
    console.log("PASS 커서 — 탭 버튼 cursor:pointer");

    // 액트 탭: 라인급 정렬(3단계 + aria-sort). 첫 클럽 총괄 표의 라인급 헤더.
    const actLineGradeBtn = page.getByRole("button", { name: "라인 급 기준 정렬" }).first();
    const actTh = page.locator("th", { has: page.getByRole("button", { name: "라인 급 기준 정렬" }) }).first();
    assert((await actTh.getAttribute("aria-sort")) === "none", "라인급 초기 aria-sort=none 아님");
    await actLineGradeBtn.click();
    await page.waitForTimeout(200);
    assert((await actTh.getAttribute("aria-sort")) === "ascending", "라인급 1클릭 ascending 아님");
    await actLineGradeBtn.click();
    await page.waitForTimeout(200);
    assert((await actTh.getAttribute("aria-sort")) === "descending", "라인급 2클릭 descending 아님");
    await actLineGradeBtn.click();
    await page.waitForTimeout(200);
    assert((await actTh.getAttribute("aria-sort")) === "none", "라인급 3클릭 기본복귀(none) 아님");
    console.log("PASS 액트 체크 — 라인 급 3단계 정렬 + aria-sort");

    // 라인 개설 관리 탭으로 전환 → LineOpeningTable 정렬
    await page.locator('[data-tab="line"]').click();
    await page.waitForSelector("[data-hub-section='info-line-opening'] table", { timeout: 20_000 });
    await page.waitForTimeout(500);
    // 첫 LineOpeningTable = 실무 정보(가장 먼저 렌더). 페이지 레벨 .first() 로 스코프.
    const nameBtn = page.getByRole("button", { name: "라인명 기준 정렬" }).first();
    const nameTh = page.locator('th:has(button[aria-label="라인명 기준 정렬"])').first();
    const firstName = () => page.locator("[data-info-open-line] td:first-child").first().innerText();
    const before = await firstName();
    await nameBtn.click();
    await page.waitForTimeout(200);
    assert((await nameTh.getAttribute("aria-sort")) === "ascending", "라인명 1클릭 ascending 아님");
    const asc = await firstName();
    await nameBtn.click();
    await page.waitForTimeout(200);
    assert((await nameTh.getAttribute("aria-sort")) === "descending", "라인명 2클릭 descending 아님");
    const desc = await firstName();
    assert(asc !== desc, "라인명 asc/desc 첫 행이 동일(정렬 미반영)");
    await nameBtn.click();
    await page.waitForTimeout(200);
    assert((await nameTh.getAttribute("aria-sort")) === "none", "라인명 3클릭 기본복귀 아님");
    assert((await firstName()) === before, "라인명 기본 복귀 후 첫 행이 원본과 다름");
    console.log("PASS 라인 개설 — 라인명 3단계 정렬(asc≠desc·기본복귀=원본)");

    // 도움말 클릭이 정렬을 실행하지 않음(라인명 컬럼 돋보기)
    const nameHelp = nameTh.getByRole("button", { name: "이 항목 도움말" });
    await nameHelp.click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ state: "visible", timeout: 8000 });
    assert((await nameTh.getAttribute("aria-sort")) === "none", "도움말 클릭이 정렬을 실행함");
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "편집 버튼 없음(편집 모달 아님)");
    console.log("PASS 도움말 클릭 → 정렬 미발생 + 편집 모달");

    // 저장 → 새로고침 유지
    await page.getByRole("button", { name: "편집" }).click();
    const ta = dlg.locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill(marker);
    const put = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "저장" }).click();
    assert((await put).ok(), "저장 PUT 실패");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-managed-week]", { timeout: 30_000 });
    await page.locator('[data-tab="line"]').click();
    await page.waitForSelector("[data-hub-section='info-line-opening'] table", { timeout: 20_000 });
    await page.waitForTimeout(400);
    const nameTh2 = page.locator('th:has(button[aria-label="라인명 기준 정렬"])').first();
    await nameTh2.getByRole("button", { name: "이 항목 도움말" }).click();
    const dlg2 = page.getByRole("dialog");
    await dlg2.waitFor({ state: "visible", timeout: 8000 });
    await dlg2.getByText(marker.slice(0, 20), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS 도움말 저장 → 새로고침 유지");
    await page.getByRole("button", { name: "닫기" }).click();

    // help org/mode 중립
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `help 요청 org/mode 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS /api/admin/help ${helpReqs.length}건 모두 org/mode 없음(공통 키)`);

    console.log("\nALL PASS");
  } finally {
    for (const k of cleanupKeys) {
      await supabaseAdmin.from("admin_page_help_contents")
        .upsert({ page_path: k, content: "", updated_at: new Date().toISOString() }, { onConflict: "page_path" });
    }
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
