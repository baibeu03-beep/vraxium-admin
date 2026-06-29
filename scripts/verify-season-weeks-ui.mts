/**
 * '주차와 시즌 > 기간 정보'(/admin/season-weeks) UI 개편 브라우저 검증
 *  - 기간 정보 UI 노출 / 최신 순 기본 정렬 / 오래된 순 / 년도·시즌·활동 필터
 *  - 결과 수 = 필터 적용 결과(API 원본 기준 oracle) / 초기화 / 페이지당 20행 / 페이지 이동
 *  - 상호작용 전후 API 응답 불변(읽기 전용 확인)
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/verify-season-weeks-ui.mts
 */
import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const requireFromFront = createRequire(
  new URL("../../vraxium/package.json", import.meta.url),
);
const { chromium } = requireFromFront("playwright") as typeof import("playwright");

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const VIEWPORT = { width: 1440, height: 900 };

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function makeAdminCookies() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

type Page = import("playwright").Page;

type ApiRow = {
  week_id: string;
  season_key: string;
  season_label: string | null;
  season_name: string | null;
  week_number: number | null;
  week_start_date: string | null;
  week_end_date: string | null;
  is_official_rest: boolean;
  is_transition?: boolean;
  holiday_name?: string | null;
};

// 클럽 일정 공통 표기 "YY - MM - DD (요일)" — lib/clubDate.formatClubDate 와 동일 규칙.
//   날짜 내부 공백은 NBSP(U+00A0)다(줄바꿈 방지) — 렌더 UI 와 동일하게 NBSP 로 생성해야
//   startsWith 비교가 일치한다.
function formatKoreanDate(value: string) {
  const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const NB = String.fromCharCode(160);
  const [y, m, d] = value.split("-").map(Number);
  const yy = String(((y % 100) + 100) % 100).padStart(2, "0");
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const dow = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${yy}${NB}-${NB}${mm}${NB}-${NB}${dd}${NB}(${dow})`;
}

const SEASON_CODE: Record<string, string> = {
  spring: "SP",
  summer: "SU",
  autumn: "AU",
  winter: "WI",
};
const NEXT_SEASON: Record<string, string> = {
  spring: "summer",
  summer: "autumn",
  autumn: "winter",
  winter: "spring",
};

function expectedWeekCode(row: ApiRow): string {
  const token = seasonToken(row);
  const yearMatch = row.season_key.match(/(20\d{2})/);
  const year = yearMatch ? yearMatch[1] : row.week_start_date?.slice(0, 4);
  if (!token || !year) return "-";
  const yy = year.slice(2);
  if (row.is_transition) {
    return `${yy}-${SEASON_CODE[token]}-${SEASON_CODE[NEXT_SEASON[token]]}`;
  }
  if (row.week_number == null) return "-";
  return `${yy}-${SEASON_CODE[token]}-${String(row.week_number).padStart(2, "0")}`;
}

const SEASON_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  winter: "겨울",
};

// 컴포넌트 rowRemark 와 동일 로직 (oracle)
function expectedRemark(row: ApiRow): string {
  const holidayName = row.holiday_name?.trim();
  if (holidayName) return holidayName;
  const token = seasonToken(row);
  const yearMatch = row.season_key.match(/(20\d{2})/);
  const year = yearMatch ? yearMatch[1] : row.week_start_date?.slice(0, 4);
  if (row.is_transition) {
    if (!token || !year) return "";
    const next = NEXT_SEASON[token];
    const nextYear = token === "winter" ? String(Number(year) + 1) : year;
    return `${year.slice(2)}년 ${SEASON_KO[token]} 시즌 → ${nextYear.slice(2)}년 ${SEASON_KO[next]} 시즌으로의 시즌 전환 휴식`;
  }
  if (!row.is_official_rest) return "";
  if ((token === "spring" || token === "autumn") && row.week_number != null) {
    const semester = token === "spring" ? "1학기" : "2학기";
    if (row.week_number >= 6 && row.week_number <= 8) {
      return `대한민국 2/4년제 대학 학사 일정 중 ${semester} 중간고사 휴식`;
    }
    if (row.week_number >= 14 && row.week_number <= 16) {
      return `대한민국 2/4년제 대학 학사 일정 중 ${semester} 기말고사 휴식`;
    }
  }
  return "";
}

function sortLatest(list: ApiRow[]): ApiRow[] {
  return [...list].sort((a, b) => {
    const as = a.week_start_date;
    const bs = b.week_start_date;
    if (as === bs) return (a.week_number ?? 0) - (b.week_number ?? 0);
    if (!as) return 1;
    if (!bs) return -1;
    return bs.localeCompare(as);
  });
}

function seasonToken(row: ApiRow): string | null {
  const key = row.season_key.toLowerCase();
  for (const t of ["spring", "summer", "autumn", "winter"]) {
    if (key.includes(t)) return t;
  }
  const name = `${row.season_label ?? ""}${row.season_name ?? ""}`;
  if (name.includes("봄")) return "spring";
  if (name.includes("여름")) return "summer";
  if (name.includes("가을")) return "autumn";
  if (name.includes("겨울")) return "winter";
  return null;
}

// 필터 셀렉트 순서: 0=정렬, 1=년도, 2=시즌, 3=활동
async function pickSelect(page: Page, triggerIndex: number, optionLabel: string) {
  await page.locator('[data-slot="select-trigger"]').nth(triggerIndex).click();
  await page
    .getByRole("option", { name: optionLabel, exact: true })
    .first()
    .click();
  await page.waitForTimeout(200);
}

async function resultCount(page: Page) {
  const text = await page.getByTestId("result-count").innerText();
  const m = text.match(/(\d+)/);
  return m ? Number(m[1]) : NaN;
}

async function tableCells(page: Page, colIndex: number): Promise<string[]> {
  return (await page.evaluate(
    `Array.from(document.querySelectorAll('table tbody tr')).map(tr => (tr.children[${colIndex}]?.textContent || '').trim())`,
  )) as string[];
}

async function rowCount(page: Page) {
  return (await page.evaluate(
    "document.querySelectorAll('table tbody tr').length",
  )) as number;
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch({ channel: "chromium" });

  try {
    const ctx = await browser.newContext({ baseURL: baseUrl, viewport: VIEWPORT });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();

    // ── oracle: API 원본 데이터 (UI 진입 전 fingerprint) ─────────────────
    const apiBefore = await ctx.request.get("/api/admin/season-weeks");
    const beforeJson = await apiBefore.json();
    const rows = (beforeJson?.data?.rows ?? []) as ApiRow[];
    check("API 응답 정상 (oracle 확보)", apiBefore.ok() && rows.length > 0, `rows=${rows.length}`);

    const dated = rows.filter((r) => r.week_start_date);
    const maxStart = dated.reduce((a, r) => (r.week_start_date! > a ? r.week_start_date! : a), "0000");
    const minStart = dated.reduce((a, r) => (r.week_start_date! < a ? r.week_start_date! : a), "9999");

    const apiConflicts = (beforeJson?.data?.conflicts ?? []) as Array<unknown>;

    // ── 1) 기간 정보 UI 노출 ────────────────────────────────────────────
    await page.goto("/admin/season-weeks", { waitUntil: "networkidle" });
    {
      const bodyText = (await page.evaluate("document.body.innerText")) as string;
      const m = bodyText.match(/어긋나는 주차 (\d+)건/);
      check(
        `충돌 경고 문구 건수 = API conflicts(${apiConflicts.length}건)`,
        apiConflicts.length === 0 ? m === null : m?.[1] === String(apiConflicts.length),
        m?.[0] ?? "문구 없음",
      );
    }
    check(
      "페이지 제목 '기간 정보' 노출",
      await page.getByRole("heading", { name: "기간 정보", exact: true }).isVisible(),
    );
    const headers = (await page.evaluate(
      "Array.from(document.querySelectorAll('table thead th')).map(th => (th.textContent||'').trim())",
    )) as string[];
    check(
      "테이블 컬럼 = 이름/기간/년도/시즌/주차/활동/비고",
      JSON.stringify(headers) ===
        JSON.stringify(["이름", "기간", "년도", "시즌", "주차", "활동", "비고"]),
      headers.join(","),
    );
    // 이름 컬럼 = UI 계산 주차 코드 (UUID 비노출)
    const page1Expected = sortLatest(rows).slice(0, 20);
    const names = await tableCells(page, 0);
    check(
      "이름 컬럼 = 주차 코드 패턴 (예: 26-SP-01, 26-SU-AU)",
      names.length > 0 &&
        names.every((n) =>
          /^\d{2}-(SP|SU|AU|WI)-(\d{2}|SP|SU|AU|WI)$/.test(n),
        ),
      Array.from(new Set(names)).slice(0, 5).join(","),
    );
    check(
      "이름 컬럼 = API 기준 기대 코드와 일치(1페이지 전수)",
      JSON.stringify(names) ===
        JSON.stringify(page1Expected.map(expectedWeekCode)),
      `first ui='${names[0]}' expected='${expectedWeekCode(page1Expected[0])}'`,
    );
    check(
      "UUID(weeks.id) 비노출",
      !(await page.evaluate(
        "/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(document.querySelector('table')?.innerText || '')",
      )),
    );

    // 전수: 모든 행의 기대 코드가 동일 패턴(판별 불가 '-' 없음)
    check(
      "주차 코드 전수(153행) 동일 패턴 — 판별 불가 없음",
      rows.every((r) =>
        /^\d{2}-(SP|SU|AU|WI)-(\d{2}|SP|SU|AU|WI)$/.test(expectedWeekCode(r)),
      ),
      rows
        .map(expectedWeekCode)
        .filter(
          (c) => !/^\d{2}-(SP|SU|AU|WI)-(\d{2}|SP|SU|AU|WI)$/.test(c),
        )
        .slice(0, 3)
        .join(","),
    );

    // 비고 컬럼 = 사용자용 파생 문구 (holiday_name > 전환 문구 > 시험기간 문구 > 빈칸)
    check(
      "API 응답에 holiday_name 필드 포함",
      rows.every((r) => "holiday_name" in r),
    );
    const remarks = await tableCells(page, 6);
    check(
      "비고 컬럼 = 파생 문구 일치(1페이지 전수)",
      JSON.stringify(remarks) ===
        JSON.stringify(page1Expected.map(expectedRemark)),
      `nonEmpty=${remarks.filter(Boolean).length}/20`,
    );
    check(
      "공식 휴식 행 비고 문구 채움(1페이지 시험기간 행)",
      page1Expected
        .filter((r) => r.is_official_rest && !r.is_transition)
        .every((r) => expectedRemark(r).length > 0),
    );
    const tableText = (await page.evaluate(
      "document.querySelector('table')?.innerText || ''",
    )) as string;
    check(
      "official_rest_sources 라벨 미노출(시험기간 규칙/날짜 등록/legacy)",
      !/시험기간 규칙|날짜 등록|legacy/i.test(tableText),
    );

    // 년도 드롭다운 순서: - / 2026 / 2025 / 2024 / 2023 / 2022
    await page.locator('[data-slot="select-trigger"]').nth(1).click();
    await page.waitForTimeout(150);
    const yearOptions = (await page.evaluate(
      "Array.from(document.querySelectorAll('[data-slot=\"select-item\"]')).map(e => (e.textContent||'').trim())",
    )) as string[];
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check(
      "년도 드롭다운 순서 = - / 2026 / 2025 / 2024 / 2023 / 2022",
      JSON.stringify(yearOptions) ===
        JSON.stringify(["-", "2026년", "2025년", "2024년", "2023년", "2022년"]),
      yearOptions.join(","),
    );

    // ── 2) 최신 순 기본 정렬 ────────────────────────────────────────────
    check("결과 수 = 전체 행 수", (await resultCount(page)) === rows.length, `ui vs api=${rows.length}`);
    const firstPeriodLatest = (await tableCells(page, 1))[0] ?? "";
    check(
      "최신 순 기본: 첫 행 = 주차 시작일 최댓값",
      firstPeriodLatest.startsWith(formatKoreanDate(maxStart)),
      `first='${firstPeriodLatest}' expected start='${formatKoreanDate(maxStart)}'`,
    );
    check("페이지당 최대 20행", (await rowCount(page)) === Math.min(20, rows.length));
    await page.screenshot({ path: "claudedocs/browser-season-weeks-period-info.png" });

    // ── 3) 오래된 순 ───────────────────────────────────────────────────
    await pickSelect(page, 0, "오래된 순");
    const firstPeriodOldest = (await tableCells(page, 1))[0] ?? "";
    check(
      "오래된 순: 첫 행 = 주차 시작일 최솟값",
      firstPeriodOldest.startsWith(formatKoreanDate(minStart)),
      `first='${firstPeriodOldest}' expected start='${formatKoreanDate(minStart)}'`,
    );

    // ── 4) 년도 필터 ───────────────────────────────────────────────────
    const year = "2026";
    const expectedYear = rows.filter((r) => r.week_start_date?.startsWith(year)).length;
    await pickSelect(page, 1, `${year}년`);
    check(
      `년도 필터(${year}년): 결과 수 일치`,
      (await resultCount(page)) === expectedYear,
      `ui=${await resultCount(page)} api=${expectedYear}`,
    );
    const yearCells = await tableCells(page, 2);
    check(
      `년도 필터(${year}년): 표시 행 전부 ${year}년`,
      yearCells.length > 0 && yearCells.every((c) => c === `${year}년`),
    );
    check("년도 필터: 페이지당 최대 20행", (await rowCount(page)) <= 20);

    // ── 5) 시즌 필터 (년도 필터와 결합 상태에서 초기화 먼저) ─────────────
    await page.getByRole("button", { name: "초기화" }).click();
    await page.waitForTimeout(200);
    check("초기화: 결과 수 전체 복귀", (await resultCount(page)) === rows.length);
    const sortText = await page.locator('[data-slot="select-trigger"]').nth(0).innerText();
    check("초기화: 정렬 최신 순 복귀", sortText.includes("최신 순"), sortText);
    const firstAfterReset = (await tableCells(page, 1))[0] ?? "";
    check(
      "초기화 후 첫 행 = 최신 순",
      firstAfterReset.startsWith(formatKoreanDate(maxStart)),
    );

    const expectedSummer = rows.filter((r) => seasonToken(r) === "summer").length;
    await pickSelect(page, 2, "여름");
    check(
      "시즌 필터(여름): 결과 수 일치",
      (await resultCount(page)) === expectedSummer,
      `ui=${await resultCount(page)} api=${expectedSummer}`,
    );
    const seasonCells = await tableCells(page, 3);
    check(
      "시즌 필터(여름): 표시 시즌 ∈ {여름, 전환}",
      seasonCells.length > 0 && seasonCells.every((c) => c === "여름" || c === "전환"),
      Array.from(new Set(seasonCells)).join(","),
    );
    // 여름 필터 1페이지 코드/비고 전수 대조 (전환 주차 포함 시 함께 검증됨)
    const summerExpected = sortLatest(
      rows.filter((r) => seasonToken(r) === "summer"),
    ).slice(0, 20);
    check(
      "시즌 필터(여름): 코드/비고 = 기대값(1페이지 전수)",
      JSON.stringify(await tableCells(page, 0)) ===
        JSON.stringify(summerExpected.map(expectedWeekCode)) &&
        JSON.stringify(await tableCells(page, 6)) ===
          JSON.stringify(summerExpected.map(expectedRemark)),
    );
    const transitionRow = rows.find((r) => r.is_transition);
    if (transitionRow) {
      check(
        "전환 주차 코드 = YY-{FROM}-{TO} 시즌 코드 형식",
        /^\d{2}-(SP-SU|SU-AU|AU-WI|WI-SP)$/.test(expectedWeekCode(transitionRow)),
        expectedWeekCode(transitionRow),
      );
      check(
        "전환 주차 비고 = 시즌 전환 자동 문구",
        expectedRemark(transitionRow).includes("시즌으로의 시즌 전환 휴식"),
        expectedRemark(transitionRow),
      );
    } else {
      console.log("SKIP | 전환 주차 데이터 없음");
    }
    await page.screenshot({ path: "claudedocs/browser-season-weeks-filter-summer.png" });

    // ── 6) 활동 필터 ───────────────────────────────────────────────────
    await page.getByRole("button", { name: "초기화" }).click();
    await page.waitForTimeout(200);
    const expectedRest = rows.filter((r) => r.is_official_rest).length;
    await pickSelect(page, 3, "공식 휴식");
    check(
      "활동 필터(공식 휴식): 결과 수 일치",
      (await resultCount(page)) === expectedRest,
      `ui=${await resultCount(page)} api=${expectedRest}`,
    );
    const activityCells = await tableCells(page, 5);
    check(
      "활동 필터(공식 휴식): 표시 행 전부 공식 휴식",
      activityCells.length > 0 && activityCells.every((c) => c === "공식 휴식"),
    );
    await page.screenshot({ path: "claudedocs/browser-season-weeks-filter-rest.png" });

    const expectedOfficial = rows.filter((r) => !r.is_official_rest).length;
    await pickSelect(page, 3, "공식 활동");
    check(
      "활동 필터(공식 활동): 결과 수 일치",
      (await resultCount(page)) === expectedOfficial,
      `ui=${await resultCount(page)} api=${expectedOfficial}`,
    );

    // ── 7) 페이지네이션 ────────────────────────────────────────────────
    await page.getByRole("button", { name: "초기화" }).click();
    await page.waitForTimeout(200);
    if (rows.length > 20) {
      const totalPages = Math.ceil(rows.length / 20);
      check(
        "페이지 표시: 1 / N",
        (await page.locator("text=/1 \\/ \\d+ 페이지/").count()) === 1,
      );
      const firstP1 = (await tableCells(page, 1))[0];
      await page.getByRole("button", { name: "다음", exact: true }).click();
      await page.waitForTimeout(200);
      const firstP2 = (await tableCells(page, 1))[0];
      check("다음 페이지: 내용 변경", firstP1 !== firstP2, `p1='${firstP1}' p2='${firstP2}'`);
      check(
        "2페이지 행 수 정상",
        (await rowCount(page)) === Math.min(20, rows.length - 20),
      );
      check(
        "페이지 표시: 2 / N",
        (await page.locator(`text=/2 \\/ ${totalPages} 페이지/`).count()) === 1,
      );
      // 필터 변경 시 1페이지 복귀
      await pickSelect(page, 1, "2026년");
      const indicator = await page
        .locator("text=/\\d+ \\/ \\d+ 페이지/")
        .count();
      const backToFirst =
        indicator === 0 ||
        (await page.locator("text=/^1 \\/ \\d+ 페이지/").count()) === 1 ||
        (await page.evaluate(
          "document.body.innerText.match(/(\\d+) \\/ \\d+ 페이지/)?.[1]",
        )) === "1";
      check("필터 변경 시 1페이지 복귀", backToFirst);
    } else {
      console.log("SKIP | 전체 행 20개 이하 — 페이지네이션 시나리오 생략");
    }

    // ── 8) 데이터 불변(읽기 전용) 확인 ──────────────────────────────────
    const apiAfter = await ctx.request.get("/api/admin/season-weeks");
    const afterJson = await apiAfter.json();
    const rowsAfter = (afterJson?.data?.rows ?? []) as ApiRow[];
    check(
      "상호작용 후 API rows 불변",
      JSON.stringify(rows) === JSON.stringify(rowsAfter),
      `before=${rows.length} after=${rowsAfter.length}`,
    );

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
