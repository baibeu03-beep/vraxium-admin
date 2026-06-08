/**
 * 브라우저 E2E 검증: /admin/lines/info 필터·검색·정렬·페이지네이션 (2026-06-07).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-filters-browser.ts
 * READ-ONLY. 스크린샷: claudedocs/browser-lines-info-filters.png
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

// 현재 페이지(테이블)에서 (org, hub, type, code, mode, status) 행 추출
async function readRows(page: Page) {
  return page.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const td = tr.querySelectorAll("td");
      return {
        name: td[0]?.textContent?.trim() ?? "",
        org: td[1]?.textContent?.trim() ?? "",
        hub: td[2]?.textContent?.trim() ?? "",
        type: td[3]?.textContent?.trim() ?? "",
        code: td[4]?.textContent?.trim() ?? "",
        mode: td[5]?.textContent?.trim() ?? "",
        title: td[6]?.textContent?.trim() ?? "",
        unit: td[7]?.textContent?.trim() ?? "",
        status: td[8]?.textContent?.trim() ?? "",
        bridge: td[9]?.textContent?.trim() ?? "",
      };
    }),
  );
}

async function resultCount(page: Page): Promise<{ shown: number; pageNo: number; pageCount: number }> {
  const desc = (await page.getByText(/검색 결과 \d+건/).textContent()) ?? "";
  const m = desc.match(/검색 결과 ([\d,]+)건.*페이지 (\d+)\/(\d+)/);
  if (!m) throw new Error(`결과 수 표기 파싱 실패: "${desc}"`);
  return {
    shown: Number(m[1].replace(/,/g, "")),
    pageNo: Number(m[2]),
    pageCount: Number(m[3]),
  };
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

    console.log("=== A) 초기 로드 — 기본 정렬 + 결과 수 + 페이지네이션 ===");
    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=등록된 라인", { timeout: 20000 });
    const rc = await resultCount(page);
    check("결과 수 표기 (검색 결과 N건 · 페이지 p/N)", rc.shown > 0, `결과=${rc.shown} 페이지=${rc.pageNo}/${rc.pageCount}`);
    const page1 = await readRows(page);
    check("페이지당 20행 이하", page1.length <= 20, `rows=${page1.length}`);
    check(
      "페이지 수 = ceil(결과/20)",
      rc.pageCount === Math.ceil(rc.shown / 20),
      `${rc.pageCount} vs ceil(${rc.shown}/20)`,
    );
    check(
      "기본 정렬 셀렉트 선택값 = 기본 정렬",
      (await page.getByLabel("정렬").inputValue()) === "default",
    );

    console.log("\n=== B) 기본 정렬 결정성 — 재로드 2회 동일 + 정렬 규칙 ===");
    // 전 페이지 순회로 전체 순서 수집
    const collectAll = async () => {
      const all: Awaited<ReturnType<typeof readRows>> = [];
      // 1페이지로 이동
      const { pageCount } = await resultCount(page);
      for (let p = 1; p <= pageCount; p++) {
        await page.getByRole("button", { name: `${p}페이지` }).click();
        await page.waitForTimeout(200);
        all.push(...(await readRows(page)));
      }
      await page.getByRole("button", { name: "1페이지" }).click();
      await page.waitForTimeout(200);
      return all;
    };
    const fullA = await collectAll();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("text=등록된 라인", { timeout: 20000 });
    const fullB = await collectAll();
    check(
      "재로드 후 전체 순서 완전 동일 (안정적 기본 정렬)",
      JSON.stringify(fullA.map((r) => r.code + r.name)) ===
        JSON.stringify(fullB.map((r) => r.code + r.name)),
      `rows=${fullA.length}`,
    );
    // 기본 정렬 규칙: org(encre→oranke→phalanx→common) → hub(정보→경험→역량→경력) → 종류 → 코드 asc
    const ORG_RANK: Record<string, number> = { encre: 0, oranke: 1, phalanx: 2, common: 3, "-": 9 };
    const HUB_RANK: Record<string, number> = { "실무 정보": 0, "실무 경험": 1, "실무 역량": 2, "실무 경력": 3 };
    const TYPE_RANK: Record<string, number> = {
      일반: 0, 도출: 1, 분석: 2, 평가: 3, 관리: 4, 확장: 5, 원리: 6, 기술: 7, 관점: 8, 자원: 9,
    };
    const keyOf = (r: (typeof fullA)[number]) =>
      [ORG_RANK[r.org] ?? 8, HUB_RANK[r.hub] ?? 8, TYPE_RANK[r.type] ?? 99] as const;
    let ordered = true;
    for (let i = 1; i < fullA.length; i++) {
      const a = keyOf(fullA[i - 1]);
      const b = keyOf(fullA[i]);
      const cmp =
        a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2];
      if (cmp > 0) { ordered = false; break; }
      if (cmp === 0 && fullA[i - 1].code.localeCompare(fullA[i].code, "ko") > 0) {
        ordered = false;
        break;
      }
    }
    check("기본 정렬 규칙 (클럽→허브→종류→코드 asc) 충족", ordered);

    console.log("\n=== C) 필터 5종 ===");
    // 1) 적용 클럽
    await page.getByLabel("적용 클럽 필터").selectOption("phalanx");
    await page.waitForTimeout(250);
    let rows = await readRows(page);
    let cnt = await resultCount(page);
    check(
      "적용 클럽=phalanx — 행 전부 phalanx + 1페이지 리셋",
      rows.every((r) => r.org === "phalanx") && cnt.pageNo === 1,
      `결과=${cnt.shown}`,
    );
    await page.getByLabel("적용 클럽 필터").selectOption("all");
    // 2) 허브
    await page.getByLabel("허브 필터").selectOption("experience");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    cnt = await resultCount(page);
    check(
      "허브=실무 경험 — 행 전부 실무 경험",
      rows.length > 0 && rows.every((r) => r.hub === "실무 경험"),
      `결과=${cnt.shown}`,
    );
    // 3) 라인 종류 (허브 필터 유지 상태에서 결합)
    await page.getByLabel("라인 종류 필터").selectOption("도출");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    cnt = await resultCount(page);
    check(
      "라인 종류=도출 (허브 결합) — 행 전부 도출",
      rows.length > 0 && rows.every((r) => r.type === "도출" && r.hub === "실무 경험"),
      `결과=${cnt.shown}`,
    );
    await page.getByLabel("허브 필터").selectOption("all");
    await page.getByLabel("라인 종류 필터").selectOption("all");
    // 4) 메인 타이틀 종류
    await page.getByLabel("메인 타이틀 종류 필터").selectOption("variable");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    cnt = await resultCount(page);
    check(
      "메인 타이틀 종류=변동 — 행 전부 변동 + 타이틀 '-'",
      rows.every((r) => r.mode === "변동" && r.title === "-"),
      `결과=${cnt.shown}`,
    );
    await page.getByLabel("메인 타이틀 종류 필터").selectOption("fixed");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    check("메인 타이틀 종류=고정 — 행 전부 고정", rows.length > 0 && rows.every((r) => r.mode === "고정"));
    await page.getByLabel("메인 타이틀 종류 필터").selectOption("all");
    // 5) 상태
    await page.getByLabel("상태 필터").selectOption("active");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    check("상태=활성 — 행 전부 활성", rows.length > 0 && rows.every((r) => r.status === "활성"));
    await page.getByLabel("상태 필터").selectOption("bridged");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    check(
      "상태=연결됨 — 행 전부 '연결됨' 뱃지",
      rows.length > 0 && rows.every((r) => r.bridge.includes("연결됨")),
    );
    await page.getByLabel("상태 필터").selectOption("unbridged");
    await page.waitForTimeout(250);
    rows = await readRows(page);
    cnt = await resultCount(page);
    check(
      "상태=미연결 — '연결됨' 뱃지 행 없음",
      rows.every((r) => !r.bridge.includes("연결됨")),
      `결과=${cnt.shown}`,
    );
    await page.getByLabel("상태 필터").selectOption("all");

    console.log("\n=== D) 검색 4필드 ===");
    await page.getByLabel("라인 검색").fill("EXBS");
    await page.waitForTimeout(400);
    rows = await readRows(page);
    check(
      "코드 검색 'EXBS' — 코드 매칭 행만",
      rows.length > 0 && rows.every((r) => r.code.includes("EXBS")),
      `rows=${rows.length}`,
    );
    // 메인 타이틀 검색 — 고정 행 하나의 타이틀 일부로 검색
    await page.getByLabel("라인 검색").fill("");
    await page.waitForTimeout(300);
    const sample = (await readRows(page)).find((r) => r.mode === "고정" && r.title.length >= 2);
    if (sample) {
      const term = sample.title.slice(0, 2);
      await page.getByLabel("라인 검색").fill(term);
      await page.waitForTimeout(400);
      rows = await readRows(page);
      check(
        `메인 타이틀 검색 '${term}' — 4필드 중 하나 매칭`,
        rows.length > 0 &&
          rows.every(
            (r) =>
              r.name.toLowerCase().includes(term.toLowerCase()) ||
              r.code.toLowerCase().includes(term.toLowerCase()) ||
              r.title.toLowerCase().includes(term.toLowerCase()) ||
              r.unit.toLowerCase().includes(term.toLowerCase()),
          ),
        `rows=${rows.length}`,
      );
    } else {
      check("메인 타이틀 검색 샘플 행 존재", false, "고정 행 없음");
    }
    await page.getByLabel("라인 검색").fill("");
    await page.waitForTimeout(300);

    console.log("\n=== E) 정렬 옵션별 동작 ===");
    const sortChecks: Array<{ value: string; field: "name" | "code"; dir: 1 | -1 }> = [
      { value: "name_asc", field: "name", dir: 1 },
      { value: "name_desc", field: "name", dir: -1 },
      { value: "code_asc", field: "code", dir: 1 },
      { value: "code_desc", field: "code", dir: -1 },
    ];
    for (const s of sortChecks) {
      await page.getByLabel("정렬").selectOption(s.value);
      await page.waitForTimeout(250);
      const rs = await readRows(page);
      let ok = true;
      for (let i = 1; i < rs.length; i++) {
        if (rs[i - 1][s.field].localeCompare(rs[i][s.field], "ko") * s.dir > 0) {
          ok = false;
          break;
        }
      }
      check(`정렬 ${s.value} — 1페이지 내 순서 충족`, ok);
    }
    // latest/oldest — 첫 행 비교
    await page.getByLabel("정렬").selectOption("latest");
    await page.waitForTimeout(250);
    const latestFirst = (await readRows(page))[0]?.code;
    await page.getByLabel("정렬").selectOption("oldest");
    await page.waitForTimeout(250);
    const oldestFirst = (await readRows(page))[0]?.code;
    check("최신/오래된 등록순 전환 시 첫 행 변경", latestFirst !== oldestFirst, `latest첫=${latestFirst} oldest첫=${oldestFirst}`);
    await page.getByLabel("정렬").selectOption("default");
    await page.waitForTimeout(250);

    console.log("\n=== F) 페이지네이션 + 결과 수 일치 ===");
    cnt = await resultCount(page);
    const pages: string[][] = [];
    for (let p = 1; p <= cnt.pageCount; p++) {
      await page.getByRole("button", { name: `${p}페이지` }).click();
      await page.waitForTimeout(200);
      // 중복 판정 키 = org|hub|code — 데이터 유니크 키와 동일 (code+name 은 3개 클럽에
      // 동일 라인이 정상 존재해 키로 부적합: EXBS-EL0001~4 × encre/oranke/phalanx).
      pages.push((await readRows(page)).map((r) => `${r.org}|${r.hub}|${r.code}`));
    }
    const flat = pages.flat();
    check("전 페이지 행 합계 = 결과 수", flat.length === cnt.shown, `${flat.length} vs ${cnt.shown}`);
    check("페이지 간 중복 행 없음", new Set(flat).size === flat.length);
    check(
      "마지막 페이지 외 전부 20행",
      pages.slice(0, -1).every((p) => p.length === 20) &&
        pages[pages.length - 1].length === cnt.shown - 20 * (cnt.pageCount - 1),
    );
    // 이전/다음 버튼
    await page.getByRole("button", { name: "1페이지" }).click();
    await page.waitForTimeout(200);
    check("1페이지에서 '이전' 비활성", await page.getByRole("button", { name: "이전 페이지" }).isDisabled());
    await page.getByRole("button", { name: "다음 페이지" }).click();
    await page.waitForTimeout(200);
    cnt = await resultCount(page);
    check("'다음' 클릭 → 2페이지", cnt.pageNo === 2);
    // 2페이지 상태에서 필터 변경 → 1페이지 리셋
    await page.getByLabel("허브 필터").selectOption("competency");
    await page.waitForTimeout(250);
    cnt = await resultCount(page);
    check("필터 변경 시 1페이지로 이동", cnt.pageNo === 1, `페이지=${cnt.pageNo}/${cnt.pageCount}`);
    await page.getByLabel("허브 필터").selectOption("all");
    await page.waitForTimeout(250);

    await page.screenshot({
      path: "claudedocs/browser-lines-info-filters.png",
      fullPage: true,
    });
    console.log("\n스크린샷: claudedocs/browser-lines-info-filters.png");

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
