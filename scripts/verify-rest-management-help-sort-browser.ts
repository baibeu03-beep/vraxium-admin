import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/rest-management 요소별 도움말(돋보기) + 테이블 컬럼 정렬 브라우저 검증.
//   A) 돋보기 17개 렌더(필터1 + 요약카드4 + 액션2 + 컬럼10) · 클릭→편집/저장 모달 · 저장→새로고침 유지
//   B) 컬럼 정렬 3단계 순환(오름→내림→기본) · 진행상태/신청시점 실제 순서 검증
//   C) 도움말 클릭이 정렬을 트리거하지 않음(순서 불변) · 정렬≠도움말 클릭 영역 분리
//   D) /api/admin/help 요청에 org/mode 파라미터 없음(공통 키)
//   E) 1440 + 390 스크린샷 · 좁은 화면 가로 스크롤 없음
//
// 데이터: phalanx/2026-summer(실데이터 0건)에 변형 6행을 시드 → 검증 후 정확히 삭제(finally).
//   실 encre 데이터는 건드리지 않는다.

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";

const ORG = "phalanx";
const SEASON = "2026-summer";

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

// ── 시드 데이터(phalanx/2026-summer) ──────────────────────────────────────────
//   진행상태 다양성: pending×4 / approved×1(미래주차) / approved+과거주차→fulfilled×1
//   분류: normal×4 / urgent×2 · 주차/신청시점/사유 모두 변형(빈 사유 1건 포함).
type Seed = {
  week_start_date: string;
  status: string;
  request_type: string;
  reason: string;
  created_at: string;
};
const SEEDS: Seed[] = [
  { week_start_date: "2026-07-13", status: "pending", request_type: "normal", reason: "가족 행사 참석", created_at: "2026-07-01T00:10:00.000Z" },
  { week_start_date: "2026-07-20", status: "approved", request_type: "urgent", reason: "병원 입원", created_at: "2026-07-03T00:10:00.000Z" },
  { week_start_date: "2026-06-29", status: "approved", request_type: "normal", reason: "학교 시험 기간", created_at: "2026-07-02T00:10:00.000Z" },
  { week_start_date: "2026-07-27", status: "pending", request_type: "urgent", reason: "", created_at: "2026-07-05T00:10:00.000Z" },
  { week_start_date: "2026-07-13", status: "pending", request_type: "normal", reason: "이사", created_at: "2026-07-04T00:10:00.000Z" },
  { week_start_date: "2026-07-20", status: "pending", request_type: "normal", reason: "여행", created_at: "2026-07-06T00:10:00.000Z" },
];

async function seedRows(): Promise<string[]> {
  // week_id 는 weeks.id(전역, start_date 키) FK — 시드 주차 시작일로 실제 week_id 매핑.
  const dates = [...new Set(SEEDS.map((s) => s.week_start_date))];
  const { data: weeks, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date")
    .in("start_date", dates);
  if (wkErr) throw new Error(`weeks lookup failed: ${wkErr.message}`);
  const weekIdByDate = new Map<string, string>();
  for (const w of (weeks ?? []) as Array<{ id: string; start_date: string }>) {
    weekIdByDate.set(w.start_date, w.id);
  }
  for (const d of dates) {
    assert(weekIdByDate.has(d), `weeks 에 ${d} 없음 — 시드 주차 조정 필요`);
  }

  // user_id 는 user_profiles FK — 실제 user_id 6개를 빌려 시드(검증 후 행 삭제).
  const { data: users, error: uErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .limit(SEEDS.length);
  if (uErr) throw new Error(`user lookup failed: ${uErr.message}`);
  const userIds = (users ?? []).map((u) => (u as { user_id: string }).user_id);
  assert(userIds.length === SEEDS.length, `user_profiles 부족: ${userIds.length}`);

  const rows = SEEDS.map((s, i) => ({
    id: randomUUID(),
    user_id: userIds[i],
    org: ORG,
    season_key: SEASON,
    week_id: weekIdByDate.get(s.week_start_date)!,
    week_start_date: s.week_start_date,
    reason: s.reason,
    status: s.status,
    request_type: s.request_type,
    created_at: s.created_at,
  }));
  const { error } = await supabaseAdmin.from("vacation_requests").insert(rows);
  if (error) throw new Error(`seed insert failed: ${error.message}`);
  return rows.map((r) => r.id);
}

// ── help sniffer(org/mode 누수 확인) ─────────────────────────────────────────
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

// 컬럼별 셀 텍스트(위→아래). 1-indexed nth-child.
async function columnCells(page: Page, nth: number): Promise<string[]> {
  return page.$$eval(
    `table tbody tr td:nth-child(${nth})`,
    (cells) => cells.map((c) => (c.textContent ?? "").trim()),
  );
}

const STATUS_RANK: Record<string, number> = {
  "휴식 신청": 0,
  "휴식 승인": 1,
  "휴식 이행": 2,
};

function ranks(cells: string[]): number[] {
  return cells.map((t) => STATUS_RANK[t]).filter((n) => n != null);
}
function isNonDecreasing(v: number[]): boolean {
  return v.every((n, i) => i === 0 || v[i - 1] <= n);
}
function isNonIncreasing(v: number[]): boolean {
  return v.every((n, i) => i === 0 || v[i - 1] >= n);
}

// "2026년 7월 14일 오전 9:00" → 정렬 비교용 숫자(빈칸은 NaN).
function parseKstLabel(t: string): number {
  const m = t.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!m) return Number.NaN;
  let hour = Number(m[5]);
  if (m[4] === "오후" && hour !== 12) hour += 12;
  if (m[4] === "오전" && hour === 12) hour = 0;
  return (
    Number(m[1]) * 1e8 +
    Number(m[2]) * 1e6 +
    Number(m[3]) * 1e4 +
    hour * 100 +
    Number(m[6])
  );
}

async function main() {
  const seedIds = await seedRows();
  console.log(`SEEDED ${seedIds.length} rows into ${ORG}/${SEASON}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  wireHelpSniffer(page);

  const marker = `[QA ${new Date().toISOString()}] 휴식관리 도움말 유지 검증`;

  try {
    // ══ 0) org 미선택 → 클럽 선택 안내 ══════════════════════════════════════════
    await page.goto(`${baseUrl}/admin/rest-management`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    assert(
      await page.getByText("상단 탭에서 클럽").isVisible(),
      "org 미선택 안내 문구 없음",
    );
    console.log("PASS 0 org 미선택 → 클럽 선택 안내");

    // ══ A) phalanx 페이지 — 돋보기 17개 ═════════════════════════════════════════
    await page.goto(`${baseUrl}/admin/rest-management?org=${ORG}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });
    await page.waitForTimeout(600);

    const mags = page.getByRole("button", { name: "이 항목 도움말" });
    const count = await mags.count();
    assert(count === 17, `돋보기 17개 기대(필터1+카드4+액션2+컬럼10), 실제 ${count}`);
    console.log(`PASS A1 돋보기 ${count}개 렌더(필터1+카드4+액션2+컬럼10)`);
    await page.screenshot({ path: `${SHOT_DIR}/qa-rest-mgmt-help-1440.png`, fullPage: true });

    // 시드 6행 이상 표시되는지(진행상태 셀 수).
    const statusCells0 = await columnCells(page, 1);
    assert(statusCells0.length >= 6, `시드 행 표시 부족: ${statusCells0.length}`);
    console.log(`PASS A2 목록 ${statusCells0.length}행 표시`);

    // ══ C) 도움말 클릭이 정렬을 트리거하지 않음 ═════════════════════════════════
    const beforeHelp = await columnCells(page, 8); // 신청 시점
    const statusHeadHelp = page
      .locator("thead th")
      .filter({ hasText: "진행 상태" })
      .getByRole("button", { name: "이 항목 도움말" });
    await statusHeadHelp.click();
    const dlg = page.getByRole("dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS C1 컬럼 헤더 돋보기 → 편집/저장 모달");
    assert(await page.getByRole("button", { name: "편집" }).isVisible(), "[편집] 버튼 없음");
    assert(await page.getByRole("button", { name: "저장" }).isVisible(), "[저장] 버튼 없음");

    // 편집→저장(도움말 저장/조회 API 연결 근거).
    await page.getByRole("button", { name: "편집" }).click();
    const ta = dlg.locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill(marker);
    const putResp = page.waitForResponse(
      (r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "저장" }).click();
    assert((await putResp).ok(), "도움말 저장 PUT 실패");
    console.log("PASS C2 편집→저장 PUT 200");
    await page.getByRole("button", { name: "닫기" }).click();
    await page.waitForTimeout(300);

    const afterHelp = await columnCells(page, 8);
    assert(
      JSON.stringify(beforeHelp) === JSON.stringify(afterHelp),
      "도움말 클릭이 정렬을 변경함",
    );
    console.log("PASS C3 도움말 클릭이 정렬을 트리거하지 않음(순서 불변)");

    // ══ B) 진행 상태 정렬 3단계 순환 ════════════════════════════════════════════
    const statusSort = page.getByRole("button", { name: "진행 상태 정렬" });
    await statusSort.click();
    await page.waitForTimeout(300);
    const asc = ranks(await columnCells(page, 1));
    assert(isNonDecreasing(asc), `진행상태 오름차순 실패: ${asc.join(",")}`);
    console.log(`PASS B1 1차 클릭 = 오름차순 [${asc.join(",")}]`);

    await statusSort.click();
    await page.waitForTimeout(300);
    const desc = ranks(await columnCells(page, 1));
    assert(isNonIncreasing(desc), `진행상태 내림차순 실패: ${desc.join(",")}`);
    console.log(`PASS B2 2차 클릭 = 내림차순 [${desc.join(",")}]`);

    await statusSort.click();
    await page.waitForTimeout(300);
    const statusTh = page.locator("thead th").filter({ hasText: "진행 상태" });
    const ariaSort = await statusTh.getAttribute("aria-sort");
    assert(ariaSort === "none", `3차 클릭 후 aria-sort=none 기대, 실제 ${ariaSort}`);
    console.log("PASS B3 3차 클릭 = 기본 순서 복귀(aria-sort=none)");

    // ══ B') 신청 시점 정렬(실제 timestamp) ══════════════════════════════════════
    const timeSort = page.getByRole("button", { name: "신청 시점 정렬" });
    await timeSort.click();
    await page.waitForTimeout(300);
    const tAsc = (await columnCells(page, 8)).map(parseKstLabel).filter((n) => !Number.isNaN(n));
    assert(isNonDecreasing(tAsc), `신청시점 오름차순 실패: ${tAsc.join(",")}`);
    console.log("PASS B4 신청 시점 오름차순(실제 timestamp)");
    await timeSort.click();
    await page.waitForTimeout(300);
    const tDesc = (await columnCells(page, 8)).map(parseKstLabel).filter((n) => !Number.isNaN(n));
    assert(isNonIncreasing(tDesc), `신청시점 내림차순 실패: ${tDesc.join(",")}`);
    console.log("PASS B5 신청 시점 내림차순(실제 timestamp)");
    await timeSort.click(); // 기본 복귀
    await page.waitForTimeout(200);

    // ══ A3) 저장 내용 새로고침 유지 ════════════════════════════════════════════
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("table tbody tr", { timeout: 15_000 });
    await page.waitForTimeout(400);
    await page
      .locator("thead th")
      .filter({ hasText: "진행 상태" })
      .getByRole("button", { name: "이 항목 도움말" })
      .click();
    const dlg2 = page.getByRole("dialog");
    await dlg2.waitFor({ state: "visible", timeout: 10_000 });
    await dlg2.getByText(marker.slice(0, 20), { exact: false }).waitFor({ state: "visible", timeout: 10_000 });
    console.log("PASS A3 새로고침 후 저장 내용 유지");
    await page.getByRole("button", { name: "닫기" }).click();

    // ══ E) 390px 좁은 화면 — 가로 스크롤 없음 ═══════════════════════════════════
    await page.setViewportSize({ width: 390, height: 900 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow <= 2, `390px 본문 가로 오버플로 발생: ${overflow}px`);
    console.log(`PASS E1 390px 본문 가로 스크롤 없음(overflow=${overflow}px)`);
    await page.screenshot({ path: `${SHOT_DIR}/qa-rest-mgmt-help-390.png`, fullPage: true });

    // ══ D) org/mode 중립 ═══════════════════════════════════════════════════════
    const leaked = helpReqs.filter((r) => r.mode !== null || r.org !== null);
    assert(leaked.length === 0, `org/mode 파라미터 누수: ${JSON.stringify(leaked.slice(0, 3))}`);
    console.log(`PASS D /api/admin/help ${helpReqs.length}건 모두 org/mode 파라미터 없음`);

    console.log("\nALL PASS");
    console.log("captured help keys:", [...cleanupKeys].sort().join(", "));
  } finally {
    // 시드 삭제(정확히 삽입한 것만).
    const { error: delErr } = await supabaseAdmin
      .from("vacation_requests")
      .delete()
      .in("id", seedIds);
    console.log(delErr ? `CLEANUP seed FAILED: ${delErr.message}` : `CLEANUP ${seedIds.length} seed rows deleted`);
    // 검증용 도움말 정리(빈 문자열).
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
