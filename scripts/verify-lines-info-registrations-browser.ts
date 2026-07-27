/**
 * 브라우저 E2E 검증: 라인 정보 표 (/admin/lines/info · /admin/lines/register 공유 컴포넌트).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-registrations-browser.ts
 * READ-ONLY (수정 모달은 열고 취소만). 스크린샷: claudedocs/browser-lines-info-registrations.png
 *
 * 2026-07-27 개정 — '개설 연결'이 **조건부 컬럼**이 되면서 고정 11컬럼 단언을 바꿨다.
 *   · 기본(전건 연결) = 11컬럼, '개설 연결' 헤더 없음
 *   · 미연결 행 존재  = 12컬럼, '개설 연결' 헤더 노출
 *   두 상태를 모두 허용하되 "미연결 유무 ↔ 헤더 유무"가 서로 맞는지를 단언한다.
 *   (미연결 fixture 생성/클릭/소멸까지의 전체 시나리오는
 *    scripts/verify-lines-bridge-column-conditional.ts 가 담당한다.)
 *
 * ⚠ 공용 Table 은 20행/페이지 페이지네이션이 기본이다 — 셀 단언은 현재 페이지 기준이다.
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

// 조건부 '개설 연결'을 제외한 고정 컬럼 — 이 순서/구성은 불변 계약이다.
const BASE_COLUMNS = [
  "적용 클럽",
  "라인 코드",
  "라인명",
  "소속 허브",
  "라인 종류",
  "소요 시간",
  "Point A",
  "Point B",
  "메인 타이틀 내용",
  "유닛",
  "수정",
];
const BRIDGE_HEADER = "개설 연결";

// 미연결 판정에 필요한 DTO 필드만(화면 판정식 isUnlinkedRow 과 동일 기준).
type LinkStateRow = { pointActivityTypeId: string | null; bridgedMasterId: string | null };

async function headerLabels(page: Page): Promise<string[]> {
  const raw = await page.locator("table thead th").allTextContents();
  return raw.map((t) => t.replace(/\s+/g, " ").trim());
}

// 스켈레톤 행에는 [수정] 버튼이 없다 → 실데이터 렌더 완료 신호.
async function waitTable(page: Page) {
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  await page
    .locator("tbody")
    .getByRole("button", { name: "수정" })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
}

// 미연결 행 존재 여부(HTTP 원천) — 화면의 헤더 노출과 대조하기 위한 기대값.
async function hasUnlinkedRows(cookie: string): Promise<{ has: boolean; detail: string }> {
  const parts: string[] = [];
  let has = false;
  for (const hub of ["info", "experience", "competency"] as const) {
    const res = await fetch(`${baseUrl}/api/admin/lines/registrations?hub=${hub}&limit=200`, {
      headers: { cookie },
    });
    const rows: LinkStateRow[] = (await res.json())?.data?.rows ?? [];
    const unlinked = rows.filter((r) =>
      hub === "info" ? !r.pointActivityTypeId : !r.bridgedMasterId,
    ).length;
    if (unlinked > 0) has = true;
    parts.push(`${hub}:${unlinked}/${rows.length}`);
  }
  return { has, detail: parts.join(" ") };
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
  const cookieHeader = captured.map((c) => `${c.name}=${c.value}`).join("; ");
  const unlinked = await hasUnlinkedRows(cookieHeader);

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    console.log("=== A) 렌더 + 컬럼 구성 (조건부 '개설 연결') ===");
    console.log(`  (HTTP 기준 미연결 현황: ${unlinked.detail})`);
    await page.goto(`${baseUrl}/admin/lines/info`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await waitTable(page);
    check(
      "페이지 타이틀 '라인 관리'",
      await page.getByRole("heading", { name: "라인 관리", exact: true }).isVisible(),
    );
    const headers = await headerLabels(page);
    const expected = unlinked.has
      ? [...BASE_COLUMNS.slice(0, 10), BRIDGE_HEADER, "수정"]
      : BASE_COLUMNS;
    check(
      `헤더 = ${expected.length}컬럼 (미연결 ${unlinked.has ? "있음 → '개설 연결' 포함" : "없음 → '개설 연결' 제외"})`,
      JSON.stringify(headers) === JSON.stringify(expected),
      headers.join(" | "),
    );
    check(
      "'개설 연결' 헤더 노출 여부 = 미연결 행 존재 여부",
      headers.includes(BRIDGE_HEADER) === unlinked.has,
    );
    const rowCount = await page.locator("tbody tr").count();
    check("행 렌더 (>0)", rowCount > 0, `현재 페이지 rows=${rowCount}`);
    const firstRowCells = await page.locator("tbody tr").first().locator("td").count();
    check("셀 개수 = 헤더 개수", firstRowCells === headers.length, `td=${firstRowCells}`);

    console.log("\n=== B) 적용 클럽 (1열) — 한글 배지 ===");
    const clubCells = await page.locator("tbody tr td:nth-child(1)").allTextContents();
    check(
      "적용 클럽 셀 — 공통/엥크레/오랑캐/팔랑크스/-",
      clubCells.length > 0 &&
        clubCells.every((t) => ["공통", "엥크레", "오랑캐", "팔랑크스", "-"].includes(t.trim())),
      `값: ${[...new Set(clubCells.map((t) => t.trim()))].join(", ")}`,
    );

    console.log("\n=== C) 메인 타이틀 내용 — 허브 정책 ===");
    // (허브=4열, 메인 타이틀 내용=9열)
    const pairs = await page.locator("tbody tr").evaluateAll((trs) =>
      trs.map((tr) => {
        const tds = tr.querySelectorAll("td");
        return {
          hub: tds[3]?.textContent?.trim() ?? "",
          title: tds[8]?.textContent?.trim() ?? "",
        };
      }),
    );
    const fixedHubRows = pairs.filter((t) => t.hub === "실무 경험" || t.hub === "실무 역량");
    const variableHubRows = pairs.filter((t) => t.hub === "실무 정보");
    check(
      `실무 경험/역량 행(${fixedHubRows.length}건) — 타이틀 표시`,
      fixedHubRows.every((t) => t.title.length > 0),
    );
    check(
      `실무 정보 행(${variableHubRows.length}건) — 타이틀 '-'(변동)`,
      variableHubRows.every((t) => t.title === "-"),
    );

    console.log("\n=== D) 유닛 (10열) ===");
    const unitButtons = await page
      .locator("tbody tr td:nth-child(10)")
      .getByText("유닛")
      .count();
    check("유닛 버튼/링크 = 행 수", unitButtons === rowCount, `buttons=${unitButtons}`);

    console.log("\n=== E) 개설 연결 컬럼 — 조건부 동작 ===");
    if (unlinked.has) {
      const idx = headers.indexOf(BRIDGE_HEADER) + 1;
      const cells = (await page.locator(`tbody tr td:nth-child(${idx})`).allTextContents()).map(
        (t) => t.replace(/\s+/g, " ").trim(),
      );
      check(
        "셀 = '—' 또는 복구 안내/버튼 (연결 완료 배지 미표시)",
        cells.every(
          (t) =>
            t === "—" ||
            t.includes("개설 미연결") ||
            t.includes("활동유형 미연결") ||
            t === "비활성" ||
            t === "권한 없음",
        ) && !cells.some((t) => t.includes("연결 완료")),
        `값: ${[...new Set(cells)].join(" / ")}`,
      );
    } else {
      check(
        "전건 연결 → '개설 연결' 헤더·셀 미렌더",
        !headers.includes(BRIDGE_HEADER) &&
          (await page.locator("tbody").getByRole("button", { name: BRIDGE_HEADER }).count()) === 0,
      );
    }
    const editButtons = await page.locator("tbody").getByRole("button", { name: "수정" }).count();
    check("수정 버튼 = 행 수", editButtons === rowCount, `buttons=${editButtons}`);

    console.log("\n=== F) 필터 동작 ===");
    // 허브 필터 = 다중 선택 드롭다운(체크박스 + [확인]).
    await page.getByRole("button", { name: "허브 필터" }).click();
    await page.getByRole("menu").getByText("실무 역량", { exact: true }).click();
    await page.getByRole("button", { name: "확인", exact: true }).click();
    await page.waitForTimeout(400);
    const compHubs = await page.locator("tbody tr td:nth-child(4)").allTextContents();
    check(
      "허브=실무 역량 필터",
      compHubs.length > 0 && compHubs.every((t) => t.trim() === "실무 역량"),
      `rows=${compHubs.length}`,
    );
    await page.getByRole("button", { name: "초기화" }).click();
    await page.waitForTimeout(300);
    check(
      "초기화 → 전체 복귀",
      (await page.locator("tbody tr").count()) === rowCount,
    );

    console.log("\n=== G) 수정 모달 열림/닫힘 (read-only — 저장 안 함) ===");
    await page.locator("tbody").getByRole("button", { name: "수정" }).first().click();
    await page.waitForSelector("text=라인 수정", { timeout: 10000 });
    check("수정 모달 열림", (await page.getByText("라인 수정").count()) > 0);
    await page.getByRole("button", { name: "취소" }).click();
    await page.waitForTimeout(300);
    check("수정 모달 닫힘 (저장 없음)", (await page.getByText("라인 수정").count()) === 0);

    await page.screenshot({
      path: "claudedocs/browser-lines-info-registrations.png",
      fullPage: true,
    });
    console.log("\n스크린샷: claudedocs/browser-lines-info-registrations.png");

    console.log("\n=== H) /admin/lines/register — 통합 화면(등록 폼 + 라인 정보 표) ===");
    // 2026-06-27 탭 통합 이후 register 는 "등록 폼 + 라인 정보 표"를 한 화면에 함께 둔다.
    //   (구 버전의 '표 없음' 단언은 통합 이전 UI 기준이라 폐기.)
    await page.goto(`${baseUrl}/admin/lines/register`, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    await waitTable(page);
    check(
      "register — '라인 등록' 섹션 존재",
      (await page.getByRole("heading", { name: "라인 등록" }).count()) > 0,
    );
    const registerHeaders = await headerLabels(page);
    check(
      "register — 라인 정보 표 헤더가 info 페이지와 동일(공유 컴포넌트)",
      JSON.stringify(registerHeaders) === JSON.stringify(expected),
      registerHeaders.join(" | "),
    );
    check(
      "register — '개설 연결' 노출 조건도 동일",
      registerHeaders.includes(BRIDGE_HEADER) === unlinked.has,
    );
    await page.screenshot({
      path: "claudedocs/browser-lines-register-integrated.png",
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
