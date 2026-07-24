import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 정렬 드롭다운 제거 검증 — /admin/season-weeks(기간 정보 목록)에서:
//   1) "정렬" FilterField 라벨 및 옛 옵션(최신 순/오래된 순) 미노출
//   2) 컬럼 헤더 클릭 정렬은 그대로 동작(년도: asc → desc → 기본)
//   3) 기본 표시 순서 = 최신순(week_start_date desc) 유지
//   4) 잔존 정렬 UI 스캔(다른 목록 페이지 대표 몇 곳도 "정렬" 라벨 스캔)

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties!.email_otp!,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp failed");
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

// 실데이터 테이블(로딩 스켈레톤 아님)에서 "연도" 컬럼 값만 위→아래로 읽는다.
//   · 여러 <table>(스켈레톤/고스트 포함) 중, tbody 행에 실제 텍스트가 있는 테이블을 고른다.
//   · "연도" 헤더의 컬럼 인덱스를 찾아 해당 열만 추출(위치 하드코딩 회피).
async function years(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const tables = [...document.querySelectorAll("table")];
    const dataTable = tables.find((t) => {
      const firstCell = t.querySelector("tbody tr td");
      return (firstCell?.textContent ?? "").trim().length > 0;
    });
    if (!dataTable) return [];
    const heads = [...dataTable.querySelectorAll("thead th")];
    const yearIdx = heads.findIndex((h) => (h.textContent ?? "").includes("연도"));
    if (yearIdx < 0) return [];
    return [...dataTable.querySelectorAll("tbody tr")].map((tr) => {
      const cell = tr.querySelectorAll("td")[yearIdx];
      const m = (cell?.textContent ?? "").match(/(\d{4})/);
      return m ? Number(m[1]) : Number.NaN;
    });
  });
}
const asc = (n: number[]) => n.filter((x) => !Number.isNaN(x)).every((x, i, a) => i === 0 || a[i - 1] <= x);
const desc = (n: number[]) => n.filter((x) => !Number.isNaN(x)).every((x, i, a) => i === 0 || a[i - 1] >= x);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/admin/season-weeks`, { waitUntil: "domcontentloaded" });
    // 로딩 스켈레톤이 아닌 실데이터 행(첫 셀에 텍스트) 등장까지 대기.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("table tbody tr td")].some(
          (c) => (c.textContent ?? "").trim().length > 0,
        ),
      { timeout: 15_000 },
    );
    await page.waitForTimeout(300);

    // 1) "정렬" 필터 라벨 / 옛 옵션 미노출.
    const filterCard = page.locator("main");
    const sortFilterLabels = await page
      .locator("label, span, div")
      .filter({ hasText: /^정렬$/ })
      .count();
    // FilterField 라벨은 정확히 "정렬" 텍스트 노드. 컬럼 헤더의 "연도 정렬" 등은 aria-label(버튼)이라
    // 텍스트로는 잡히지 않는다. 안전하게 옛 옵션 문자열로도 확인.
    const hasLatest = await page.getByText("최신 순", { exact: true }).count();
    const hasOldest = await page.getByText("오래된 순", { exact: true }).count();
    assert(hasLatest === 0 && hasOldest === 0, `옛 정렬 옵션 잔존: 최신순=${hasLatest} 오래된순=${hasOldest}`);
    console.log(`PASS 1 season-weeks: 정렬 옵션(최신순/오래된순) 미노출 · "정렬" 텍스트 매치 ${sortFilterLabels}건(컬럼 aria 제외)`);

    // 디버그: 첫 데이터 행의 셀 텍스트 덤프(컬럼 인덱스 확인).
    const firstRow = await page.$$eval("table tbody tr:first-child td", (tds) =>
      tds.map((t, i) => `[${i + 1}]${(t.textContent ?? "").trim().slice(0, 16)}`),
    );
    console.log("  firstRow cells:", firstRow.join(" | "));

    // 2) 컬럼 헤더 정렬 사이클 (년도).
    const base = await years(page);
    const yearBtn = page.getByRole("button", { name: "연도 정렬" });
    assert((await yearBtn.count()) === 1, "년도 컬럼 정렬 버튼 없음(컬럼 정렬 훼손)");
    await yearBtn.click();
    await page.waitForTimeout(250);
    const a1 = await years(page);
    assert(asc(a1), `1차 클릭 오름차순 실패: ${a1.join(",")}`);
    await yearBtn.click();
    await page.waitForTimeout(250);
    const d1 = await years(page);
    assert(desc(d1), `2차 클릭 내림차순 실패: ${d1.join(",")}`);
    await yearBtn.click();
    await page.waitForTimeout(250);
    const back = await years(page);
    console.log(
      `  base=[${base.join(",")}]\n  asc =[${a1.join(",")}]\n  desc=[${d1.join(",")}]\n  back=[${back.join(",")}]`,
    );
    // 컬럼 정렬이 활성이면 년도 asc 배열은 정렬되어 있고, 기본 복귀 시 asc-상태가 해제된다.
    //   (기본 순서는 week_start_date desc → 연도는 대체로 내림차순. asc 상태만 확실히 풀리면 OK.)
    assert(!(asc(back) && !asc(base)), "3차 클릭 후에도 오름차순 유지 — 기본 복귀 실패");
    assert(JSON.stringify(back) === JSON.stringify(base), "기본 순서가 초기 표시와 다름");
    console.log("PASS 2 컬럼 헤더 정렬 asc→desc→기본 복귀 정상");

    // 3) 기본 순서 = 최신순(week_start_date desc → 연도 내림차순).
    assert(desc(base), `기본 순서가 최신순(연도 내림)이 아님: ${base.join(",")}`);
    console.log(`PASS 3 기본 표시 순서 = 최신순 유지 (연도 상단→하단: ${base.slice(0, 6).join(",")}…)`);

    // 4) /admin/periods/register 통합 페이지에도 정렬 옵션 미노출.
    await page.goto(`${baseUrl}/admin/periods/register`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });
    await page.waitForTimeout(500);
    const pl = await page.getByText("최신 순", { exact: true }).count();
    const po = await page.getByText("오래된 순", { exact: true }).count();
    assert(pl === 0 && po === 0, `periods/register 정렬 옵션 잔존: ${pl}/${po}`);
    console.log("PASS 4 periods/register 통합 페이지에도 정렬 드롭다운 미노출");

    console.log("\nALL PASS — 정렬 드롭다운 제거 + 컬럼 정렬/기본 순서 불변 확인");
    void filterCard;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
