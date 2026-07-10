import { chromium, type APIRequestContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/members?tab=info (크루 정보 탭) — 돋보기/정렬/파리티 검증.
//   HTTP: info-stats 일반 vs mode=test 동일 DTO(weeks[] 구조 포함) + help org/mode 중립.
//   Browser: 돋보기 렌더/저장·유지/클릭≠정렬, 주차별 데이터 3단계 정렬+aria-sort(클라이언트 전량),
//            1440/1280/1024 무스크롤, 정렬+페이지네이션 조합.

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";

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
  const marker = `[QA-MI ${new Date().toISOString()}] column.clubCount 저장 검증`;
  const cleanupKeys = ["admin.members.info.column.clubCount"];
  const helpReqs: Array<{ mode: string | null; org: string | null }> = [];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  await context.addCookies(await makeAdminCookies());
  const api = context.request;

  try {
    // HTTP 파리티 — info-stats 일반 vs test(통합 + 조직별)
    for (const q of ["", "?organization=encre"]) {
      const sep = q ? "&" : "?";
      const n = await getJson(api, `${baseUrl}/api/admin/members/info-stats${q}`);
      const t = await getJson(api, `${baseUrl}/api/admin/members/info-stats${q}${sep}mode=test`);
      assert(keys(n.data) === keys(t.data), `info-stats DTO 키 불일치 (${q || "all"})`);
      const nw = (n.data.weeks as Array<Record<string, unknown>>) ?? [];
      const tw = (t.data.weeks as Array<Record<string, unknown>>) ?? [];
      if (nw.length && tw.length) assert(keys(nw[0]) === keys(tw[0]), `weeks row DTO 키 불일치 (${q || "all"})`);
    }
    console.log("PASS HTTP 파리티 — info-stats 일반/test 동일 DTO(통합·조직별·weeks row)");

    const allStats = await getJson(api, `${baseUrl}/api/admin/members/info-stats`);
    const weeks = (allStats.data.weeks as Array<{ seasonWeekName: string }>) ?? [];
    assert(weeks.length >= 2, `주차 수 부족(${weeks.length})`);
    const newestName = weeks[0].seasonWeekName;
    const oldestName = weeks[weeks.length - 1].seasonWeekName;
    console.log(`PASS info-stats weeks ${weeks.length}개 (최신=${newestName} / 최고참=${oldestName})`);

    // ── Browser ──
    const page = await context.newPage();
    page.on("request", (req) => {
      const u = new URL(req.url());
      if (u.pathname === "/api/admin/help") helpReqs.push({ mode: u.searchParams.get("mode"), org: u.searchParams.get("org") });
    });
    await page.goto(`${baseUrl}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid='members-info-section0']", { timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label="이 항목 도움말"]').length >= 15,
      { timeout: 20_000 },
    );
    const magCount = await page.getByRole("button", { name: "이 항목 도움말" }).count();
    console.log(`PASS 돋보기 렌더(통합 탭) — ${magCount}개`);

    for (const w of [1440, 1280, 1024] as const) {
      await page.setViewportSize({ width: w, height: 1200 });
      await page.waitForTimeout(400);
      const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      assert(ok, `body 가로 스크롤 발생 @${w}px`);
      await page.screenshot({ path: `${SHOT_DIR}/qa-mi-${w}.png` });
      console.log(`PASS 레이아웃 @${w}px — body 가로 스크롤 없음 (qa-mi-${w}.png)`);
    }
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.waitForTimeout(300);

    // 정렬 3단계 — 시즌 & 주차(seq: 항상 distinct). desc=최신(기본과 동일 첫행)·asc=최고참.
    const firstSeason = () =>
      page.locator("table tbody tr").first().locator("td").nth(1).innerText();
    const before = (await firstSeason()).trim();
    const seasonBtn = page.getByRole("button", { name: "시즌 & 주차 기준 정렬" });
    const seasonTh = page.locator('th:has(button[aria-label="시즌 & 주차 기준 정렬"])');
    assert((await seasonTh.getAttribute("aria-sort")) === "none", "시즌&주차 초기 aria-sort=none 아님");
    // 1클릭 오름차순 → 최고참 먼저
    await seasonBtn.click();
    await page.waitForTimeout(300);
    assert((await seasonTh.getAttribute("aria-sort")) === "ascending", "1클릭 ascending 아님");
    const asc = (await firstSeason()).trim();
    assert(asc !== before, "오름차순 후 첫 행이 그대로(정렬 미반영)");
    // 2클릭 내림차순 → 최신 먼저(=기본)
    await seasonBtn.click();
    await page.waitForTimeout(300);
    assert((await seasonTh.getAttribute("aria-sort")) === "descending", "2클릭 descending 아님");
    const desc = (await firstSeason()).trim();
    assert(desc === before, "내림차순 첫 행이 기본(최신) 첫 행과 다름");
    // 3클릭 기본 복귀
    await seasonBtn.click();
    await page.waitForTimeout(300);
    assert((await seasonTh.getAttribute("aria-sort")) === "none", "3클릭 기본복귀(none) 아님");
    assert((await firstSeason()).trim() === before, "기본 복귀 후 첫 행이 원본과 다름");
    console.log("PASS 주차별 데이터 — 시즌&주차 3단계 정렬 + aria-sort(전량 정렬)");

    // 정렬 + 페이지네이션 조합 — asc 정렬 후 다음 페이지 이동 정상
    if (weeks.length > 20) {
      await seasonBtn.click(); // asc
      await page.waitForTimeout(200);
      await page.getByRole("button", { name: "다음" }).click();
      await page.waitForTimeout(200);
      const pageLabel = await page.locator("text=/주차 · [0-9]+ \\//").first().innerText();
      assert(/· 2 \//.test(pageLabel), `정렬 상태 페이지 이동 실패(${pageLabel})`);
      console.log("PASS 정렬+페이지네이션 조합 — 2페이지 이동 정상");
      // 원복
      await seasonBtn.click();
      await seasonBtn.click();
      await page.waitForTimeout(200);
    }

    // 도움말 클릭이 정렬을 실행하지 않음(클럽 수 컬럼 돋보기)
    const clubCountTh = page.locator('th:has(button[aria-label="클럽 수 기준 정렬"])');
    await clubCountTh.getByRole("button", { name: "이 항목 도움말" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ state: "visible", timeout: 8000 });
    assert((await clubCountTh.getAttribute("aria-sort")) === "none", "도움말 클릭이 정렬을 실행함");
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
    await page.waitForSelector("[data-testid='members-info-section0']", { timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelectorAll('button[aria-label="이 항목 도움말"]').length >= 15,
      { timeout: 20_000 },
    );
    const clubCountTh2 = page.locator('th:has(button[aria-label="클럽 수 기준 정렬"])');
    await clubCountTh2.getByRole("button", { name: "이 항목 도움말" }).click();
    const dlg2 = page.getByRole("dialog");
    await dlg2.waitFor({ state: "visible", timeout: 8000 });
    await dlg2.getByText(marker.slice(0, 20), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS 도움말 저장 → 새로고침 유지");
    await page.getByRole("button", { name: "닫기" }).click();

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
