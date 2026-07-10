import { chromium, type APIRequestContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/team-parts/info/weeks — 서버사이드 정렬 + 돋보기 도움말 + 레이아웃 브라우저/HTTP 검증.
//   HTTP(전체 목록 기준 정렬):
//     · 기본순 = 주차 시작일 desc(최신 최상단)
//     · weekName asc == 기본순의 역순 / weekName desc == 기본순
//     · clubActivityStatus asc/desc = 업무 순서(활동↔휴식) 그룹핑
//     · aggregate(체크율·개설율·오픈라인·검수) asc=비감소 / desc=비증가 (전 페이지 연결 기준)
//     · 무효 sort 키 = 무시(기본순) / mode=test 동일 DTO·동일 정렬
//   Browser:
//     · 돋보기 개수/저장·유지 / 정렬 3단계(오름→내림→기본) + aria-sort / 도움말 클릭이 정렬 미발생
//     · 1440/1280/1024 body 가로 스크롤 없음(표는 자체 overflow-x)

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";
const PAGE_PATH = "/admin/team-parts/info/weeks";
const CLUB = "encre";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !le, le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(v.session && !ve, ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
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

type Item = {
  weekId: string;
  weekName: string;
  clubActivityStatus: "official_activity" | "official_rest";
  actCheckRate: number;
  lineOpenRate: number;
  openLines: number;
  weekReviewed: boolean;
};

// 큰 pageSize(100·서버 cap)로 요청 수를 줄인다 — 162주차 = 2페이지(dev DB 부하/플래키 완화).
const PAGE_SIZE = 100;

// 일시적 500(dev DB 포화 등) 방어 — 짧은 backoff 재시도.
async function getWithRetry(api: APIRequestContext, url: string, tries = 4) {
  let last = 0;
  for (let t = 0; t < tries; t++) {
    const r = await api.get(url);
    if (r.ok()) return r;
    last = r.status();
    await new Promise((res) => setTimeout(res, 500 * (t + 1)));
  }
  throw new Error(`API 실패 ${last} (${url})`);
}

// 주어진 정렬로 전 페이지를 연결한 items 를 반환(전체 목록 기준 검증용).
async function fetchAll(
  api: APIRequestContext,
  opts: { sort?: string; dir?: string; mode?: string } = {},
): Promise<Item[]> {
  const build = (p: number) => {
    const q = new URLSearchParams({ club: CLUB, page: String(p), pageSize: String(PAGE_SIZE) });
    if (opts.sort) q.set("sort", opts.sort);
    if (opts.dir) q.set("dir", opts.dir);
    if (opts.mode) q.set("mode", opts.mode);
    return `${baseUrl}/api/admin/team-parts/info/weeks?${q}`;
  };
  const r0 = await getWithRetry(api, build(1));
  const j0 = (await r0.json()) as { data: { items: Item[]; pagination: { totalPages: number } } };
  const totalPages = j0.data.pagination.totalPages;
  const all = [...j0.data.items];
  for (let p = 2; p <= totalPages; p++) {
    const r = await getWithRetry(api, build(p));
    const j = (await r.json()) as { data: { items: Item[] } };
    all.push(...j.data.items);
  }
  return all;
}

const ids = (xs: Item[]) => xs.map((x) => x.weekId).join(",");

async function main() {
  const marker = `[QA-TPIW ${new Date().toISOString()}] column.weekName 저장 검증`;
  const cleanupKeys = ["admin.teamPartsInfoWeeks.column.weekName"];
  const helpReqs: Array<{ mode: string | null; org: string | null }> = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies(await makeAdminCookies());
  const api = context.request;

  try {
    // ── HTTP: 전체 목록 기준 정렬 ──
    const base = await fetchAll(api);
    assert(base.length >= 40, `주차 수가 너무 적음(${base.length}) — 다중 페이지 검증 불가`);
    console.log(`PASS 기본순 로드 — 전체 ${base.length}주차(다중 페이지)`);

    // weekName asc == 기본순 역순 / desc == 기본순
    const wnAsc = await fetchAll(api, { sort: "weekName", dir: "asc" });
    const wnDesc = await fetchAll(api, { sort: "weekName", dir: "desc" });
    assert(ids(wnAsc) === ids([...base].reverse()), "weekName asc 가 기본순 역순이 아님");
    assert(ids(wnDesc) === ids(base), "weekName desc 가 기본순과 다름");
    console.log("PASS weekName 정렬 — asc=기본역순 / desc=기본순 (전 페이지 연결 기준)");

    // clubActivityStatus asc: 활동 먼저 → 휴식. desc 반대. (빈값 없음)
    const orderIdx = (s: Item["clubActivityStatus"]) => (s === "official_activity" ? 0 : 1);
    const stAsc = await fetchAll(api, { sort: "clubActivityStatus", dir: "asc" });
    const stDesc = await fetchAll(api, { sort: "clubActivityStatus", dir: "desc" });
    for (let i = 1; i < stAsc.length; i++) {
      assert(orderIdx(stAsc[i].clubActivityStatus) >= orderIdx(stAsc[i - 1].clubActivityStatus), "status asc 순서 위반");
      assert(orderIdx(stDesc[i].clubActivityStatus) <= orderIdx(stDesc[i - 1].clubActivityStatus), "status desc 순서 위반");
    }
    console.log("PASS clubActivityStatus 정렬 — 업무 순서(활동↔휴식) 그룹핑");

    // aggregate: asc 비감소 / desc 비증가 (전 페이지 연결 기준)
    const aggKeys: Array<{ k: string; get: (i: Item) => number }> = [
      { k: "actCheckRate", get: (i) => i.actCheckRate },
      { k: "lineOpenRate", get: (i) => i.lineOpenRate },
      { k: "openLines", get: (i) => i.openLines },
      { k: "weekReviewed", get: (i) => (i.weekReviewed ? 1 : 0) },
    ];
    for (const { k, get } of aggKeys) {
      const asc = await fetchAll(api, { sort: k, dir: "asc" });
      const desc = await fetchAll(api, { sort: k, dir: "desc" });
      assert(asc.length === base.length && desc.length === base.length, `${k} 정렬 총개수 불일치`);
      for (let i = 1; i < asc.length; i++) {
        assert(get(asc[i]) >= get(asc[i - 1]), `${k} asc 비감소 위반 @${i}`);
        assert(get(desc[i]) <= get(desc[i - 1]), `${k} desc 비증가 위반 @${i}`);
      }
      const distinct = new Set(asc.map(get)).size;
      console.log(`PASS ${k} 정렬 — asc 비감소 / desc 비증가 (구분값 ${distinct}종)`);
    }

    // 무효 sort 키 = 무시(기본순)
    const bogus = await fetchAll(api, { sort: "weekName; DROP", dir: "asc" });
    assert(ids(bogus) === ids(base), "무효 sort 키가 기본순으로 폴백되지 않음");
    const bogusDir = await fetchAll(api, { sort: "actCheckRate", dir: "sideways" });
    assert(ids(bogusDir) === ids(base), "무효 dir 이 기본순으로 폴백되지 않음");
    console.log("PASS 무효 sort/dir = 기본순 폴백(whitelist)");

    // mode=test 동일 DTO·동일 정렬
    const normalSorted = await fetchAll(api, { sort: "clubActivityStatus", dir: "asc" });
    const testSorted = await fetchAll(api, { sort: "clubActivityStatus", dir: "asc", mode: "test" });
    assert(ids(normalSorted) === ids(testSorted), "일반/test 정렬 결과 불일치");
    assert(
      JSON.stringify(Object.keys(normalSorted[0]).sort()) ===
        JSON.stringify(Object.keys(testSorted[0]).sort()),
      "일반/test row DTO 키 불일치",
    );
    console.log("PASS 일반/test 동일 DTO·동일 정렬");

    // ── Browser ──
    const page = await context.newPage();
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.pathname === "/api/admin/help") {
        helpReqs.push({ mode: u.searchParams.get("mode"), org: u.searchParams.get("org") });
      }
    });
    await page.goto(`${baseUrl}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-weeks-table]", { timeout: 30_000 });
    // 돋보기가 전부 렌더될 때까지 대기(dev 컴파일/하이드레이션 레이스 방지).
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label="이 항목 도움말"]').length >= 13,
      { timeout: 20_000 },
    );

    const mags = page.getByRole("button", { name: "이 항목 도움말" });
    const magCount = await mags.count();
    assert(magCount >= 13, `돋보기 13개 이상 필요(현재 ${magCount})`);
    console.log(`PASS 돋보기 렌더 — ${magCount}개(필터/현재주차/상태/10컬럼/페이지)`);

    // 레이아웃 — body 가로 스크롤 없음(표는 자체 스크롤 허용)
    for (const w of [1440, 1280, 1024] as const) {
      await page.setViewportSize({ width: w, height: 1100 });
      await page.waitForTimeout(400);
      const noBodyScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      assert(noBodyScroll, `body 가로 스크롤 발생 @${w}px`);
      await page.screenshot({ path: `${SHOT_DIR}/qa-tpiw-${w}.png` });
      console.log(`PASS 레이아웃 @${w}px — body 가로 스크롤 없음 (qa-tpiw-${w}.png)`);
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.waitForTimeout(300);

    // 정렬 3단계 + aria-sort — 주차명 헤더
    const weekNameTh = page.locator("th", { has: page.getByRole("button", { name: "주차명 기준 정렬" }) });
    const firstRowName = () => page.locator("[data-week-name]").first().innerText();
    const before = await firstRowName();
    assert((await weekNameTh.getAttribute("aria-sort")) === "none", "초기 aria-sort=none 아님");
    // 1클릭 오름차순
    await page.getByRole("button", { name: "주차명 기준 정렬" }).click();
    await page.waitForTimeout(900);
    assert((await weekNameTh.getAttribute("aria-sort")) === "ascending", "1클릭 후 ascending 아님");
    const asc1 = await firstRowName();
    assert(asc1 !== before, "오름차순 후 첫 행이 그대로(정렬 미반영)");
    // 2클릭 내림차순
    await page.getByRole("button", { name: "주차명 기준 정렬" }).click();
    await page.waitForTimeout(900);
    assert((await weekNameTh.getAttribute("aria-sort")) === "descending", "2클릭 후 descending 아님");
    const desc1 = await firstRowName();
    assert(desc1 === before, "내림차순 첫 행이 기본순 첫 행과 다름(주차명 desc==기본)");
    // 3클릭 기본 복귀
    await page.getByRole("button", { name: "주차명 기준 정렬" }).click();
    await page.waitForTimeout(900);
    assert((await weekNameTh.getAttribute("aria-sort")) === "none", "3클릭 후 none(기본 복귀) 아님");
    assert((await firstRowName()) === before, "기본 복귀 후 첫 행이 원본과 다름");
    console.log("PASS 정렬 3단계(오름→내림→기본) + aria-sort 전이");

    // 도움말 클릭이 정렬을 실행하지 않음 — 주차명 컬럼 돋보기
    const weekNameHelp = weekNameTh.getByRole("button", { name: "이 항목 도움말" });
    await weekNameHelp.click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ state: "visible", timeout: 8000 });
    assert((await weekNameTh.getAttribute("aria-sort")) === "none", "도움말 클릭이 정렬을 실행함(aria-sort 변경)");
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "[편집] 없음 — 편집 모달 아님");
    console.log("PASS 도움말 클릭 → 정렬 미발생 + 편집 모달 열림");

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
    await page.waitForSelector("[data-weeks-table]", { timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label="이 항목 도움말"]').length >= 13,
      { timeout: 20_000 },
    );
    const th2 = page.locator("th", { has: page.getByRole("button", { name: "주차명 기준 정렬" }) });
    await th2.getByRole("button", { name: "이 항목 도움말" }).click();
    const dlg2 = page.getByRole("dialog");
    await dlg2.waitFor({ state: "visible", timeout: 8000 });
    await dlg2.getByText(marker.slice(0, 24), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS 도움말 저장 → 새로고침 유지");
    await page.getByRole("button", { name: "닫기" }).click();

    // 비정렬 컬럼(전체 액트)엔 정렬 버튼 없음
    const totalActsBtn = await page.getByRole("button", { name: "전체 액트 기준 정렬" }).count();
    assert(totalActsBtn === 0, "전체 액트가 정렬 버튼을 가짐(상수 컬럼은 비정렬이어야 함)");
    console.log("PASS 상수 컬럼(전체 액트) 비정렬 — 정렬 버튼 없음");

    // help 요청 org/mode 중립
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `help 요청 org/mode 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS /api/admin/help ${helpReqs.length}건 모두 org/mode 없음(공통 키)`);

    console.log("\nALL PASS");
  } finally {
    for (const k of cleanupKeys) {
      await supabaseAdmin
        .from("admin_page_help_contents")
        .upsert({ page_path: k, content: "", updated_at: new Date().toISOString() }, { onConflict: "page_path" });
    }
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
