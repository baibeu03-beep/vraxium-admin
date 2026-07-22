// 주차 결과(크루) — 브라우저 렌더 검증(dev :3000, owner 세션).
//   [1] 통합 목록: 주차 행 × 클럽 열 · 각 셀에 활동 유형 + 3종 상태 · 클럽 헤더 [상세] 버튼
//   [2] [상세] 클릭 → /crew-week-results/{organizationSlug} 이동 · breadcrumb "클럽 정보 > 주차 결과(크루) > {클럽명}"
//   [3] 상세 화면 셀 값이 통합 목록의 같은 셀과 동일(화면 레벨 파리티)
//   [4] mode=test 도 동일 구조로 렌더(분기 없음)
//   실행: node scripts/browser-verify-crew-week-results-render.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const PATH = "/admin/team-parts/info/crew-week-results";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

const DISPLAY_LABELS = ["진행 중", "집계 중", "검수 완료"];
const KIND_LABELS = ["공식 활동", "공식 휴식"];

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function sessionCookies() {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: OWNER_EMAIL,
  });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email: OWNER_EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => ({
    name: i.name,
    value: i.value,
    domain: "localhost",
    path: "/",
  }));
}

// 화면에서 읽어낸 셀 사실 — DOM data-* 는 서버 DTO 값을 그대로 실은 것이다.
async function readCells(page) {
  return page.$$eval("[data-cell-week]", (nodes) =>
    nodes.map((n) => ({
      weekId: n.getAttribute("data-cell-week"),
      org: n.getAttribute("data-cell-org"),
      activityKind: n.getAttribute("data-activity-kind"),
      displayStatus: n.getAttribute("data-display-status"),
      lifecycleStatus: n.getAttribute("data-lifecycle-status"),
      reviewStatus: n.getAttribute("data-review-status"),
      text: n.textContent.replace(/\s+/g, " ").trim(),
    })),
  );
}

async function main() {
  const cookies = await sessionCookies();
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();

  console.log("\n[1] 통합 목록 렌더");
  await page.goto(`${BASE}${PATH}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-week-row]", { timeout: 30_000 });

  const weekRows = await page.$$("[data-week-row]");
  ck("주차 행 렌더", weekRows.length > 0, `${weekRows.length}행`);

  const clubHeaders = await page.$$eval("[data-club-header]", (n) =>
    n.map((e) => e.getAttribute("data-club-header")),
  );
  ck("클럽 열 렌더", clubHeaders.length > 0, clubHeaders.join(","));

  // 목록 breadcrumb — 기존 /admin/team-parts/info/{clubId} override 가 "crew-week-results" 를
  //   clubId 로 삼켜 "클럽 정보 > 팀 관리 > 클럽" 이 되던 회귀를 고정한다(실측 발생 → lookahead 추가).
  const listCrumb = (await page.textContent('[aria-label="현재 위치"]'))
    ?.replace(/\s+/g, " ")
    .trim();
  ck("목록 breadcrumb = 클럽 정보 > 주차 결과(크루)", listCrumb === "클럽 정보주차 결과(크루)", listCrumb);

  const detailBtns = await page.$$eval("[data-club-detail]", (n) =>
    n.map((e) => e.getAttribute("data-club-detail")),
  );
  ck(
    "클럽 헤더마다 [상세] 버튼",
    detailBtns.length === clubHeaders.length,
    `${detailBtns.length}/${clubHeaders.length}`,
  );

  // 좌측 고정 영역 = 주차명 + 주차 기간.
  const firstName = await page.textContent("[data-week-row] [data-week-name]");
  const firstPeriod = await page.textContent("[data-week-row] [data-week-period]");
  ck("좌측: 주차명 표시", !!firstName?.trim(), firstName?.trim());
  ck("좌측: 주차 기간 표시", !!firstPeriod?.trim(), firstPeriod?.trim());

  const cells = await readCells(page);
  ck(
    "셀 개수 = 주차 × 클럽",
    cells.length === weekRows.length * clubHeaders.length,
    `${cells.length}`,
  );
  ck(
    "모든 셀에 활동 유형 표기",
    cells.every((c) => KIND_LABELS.some((l) => c.text.includes(l))),
  );
  ck(
    "모든 셀에 3종 상태 중 하나 표기",
    cells.every((c) => DISPLAY_LABELS.some((l) => c.text.includes(l))),
  );
  ck(
    "displayStatus 는 서버 값만(3종)",
    cells.every((c) => ["in_progress", "aggregating", "completed"].includes(c.displayStatus)),
  );
  ck(
    "검수 완료 표기는 reviewStatus=published 에서만",
    cells.every((c) => (c.displayStatus === "completed") === (c.reviewStatus === "published")),
  );
  const statuses = [...new Set(cells.map((c) => c.displayStatus))];
  console.log(`    (참고) 화면에 나타난 상태: ${statuses.join(", ")}`);

  console.log("\n[2] [상세] 진입 · breadcrumb");
  const targetOrg = clubHeaders[0];
  await Promise.all([
    page.waitForURL(new RegExp(`${PATH}/${targetOrg}`), { timeout: 30_000 }),
    page.click(`[data-club-detail="${targetOrg}"]`),
  ]);
  ck("URL = /{organizationSlug}", page.url().includes(`${PATH}/${targetOrg}`), page.url());

  await page.waitForSelector("[data-week-row]", { timeout: 30_000 });
  const crumb = (await page.textContent('[aria-label="현재 위치"]'))?.replace(/\s+/g, " ").trim();
  ck("breadcrumb 에 '클럽 정보'", !!crumb && crumb.includes("클럽 정보"), crumb);
  ck("breadcrumb 에 '주차 결과(크루)'", !!crumb && crumb.includes("주차 결과(크루)"), crumb);
  const orgKo = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" }[targetOrg];
  ck(`breadcrumb 마지막 = 클럽명(${orgKo})`, !!crumb && crumb.includes(orgKo), crumb);
  ck("breadcrumb 에 slug 미노출", !!crumb && !crumb.includes(targetOrg), crumb);

  console.log("\n[3] 통합 == 상세 (화면 레벨 파리티)");
  // 상세는 13컬럼 목록표(행=주차)로 렌더된다 — 통합의 매트릭스 셀과 **같은 DTO** 값을 쓰므로
  //   상태/활동유형이 주차별로 완전히 일치해야 한다(표현만 다름).
  await page.waitForSelector("[data-week-link]", { timeout: 30_000 });
  const detailCols = await page.$$eval(
    "[data-crew-week-results-detail] thead th",
    (n) => n.map((e) => e.textContent.trim()),
  );
  const EXPECTED_COLS = [
    "상태", "주차명", "기간", "클럽 활동", "기준 포인트 A", "소속 크루", "시즌 휴식",
    "개인 휴식", "성장 도전", "성장 성공", "성장 실패", "성장 성공률", "성장 도전율",
  ];
  ck("13컬럼 순서 일치", JSON.stringify(detailCols) === JSON.stringify(EXPECTED_COLS), detailCols.join("·"));
  ck("표기 '성장 성공률'(성공율 아님)", detailCols.includes("성장 성공률"));

  const detailRows = await page.$$eval("[data-crew-week-results-detail] tbody tr", (rows) =>
    rows.map((r) => ({
      weekId: r.getAttribute("data-week-row"),
      displayStatus: r.querySelector("[data-display-status]")?.getAttribute("data-display-status"),
      lifecycleStatus: r.querySelector("[data-lifecycle-status]")?.getAttribute("data-lifecycle-status"),
      reviewStatus: r.querySelector("[data-review-status]")?.getAttribute("data-review-status"),
      activityKind: r.querySelector("[data-activity-kind]")?.getAttribute("data-activity-kind"),
      weekLink: r.querySelector("[data-week-link]")?.getAttribute("href"),
    })),
  );
  ck("상세 행 렌더", detailRows.length > 0, `${detailRows.length}행`);

  const integratedForOrg = new Map(cells.filter((c) => c.org === targetOrg).map((c) => [c.weekId, c]));
  const mismatch = detailRows.filter((r) => {
    const i = integratedForOrg.get(r.weekId);
    return !i || i.displayStatus !== r.displayStatus || i.lifecycleStatus !== r.lifecycleStatus
      || i.reviewStatus !== r.reviewStatus || i.activityKind !== r.activityKind;
  });
  ck("상태·활동유형이 통합 셀과 동일", mismatch.length === 0, `불일치 ${mismatch.length}`);

  const badLink = detailRows.filter((r) => r.weekLink && !r.weekLink.includes(`${PATH}/${targetOrg}/${r.weekId}`));
  ck("주차명 링크 = 불변 식별자 경로", badLink.length === 0, detailRows[0]?.weekLink ?? "");

  const firstLink = detailRows.find((r) => r.weekLink);
  if (firstLink) {
    await page.goto(`${BASE}${firstLink.weekLink}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-week-detail-pending]", { timeout: 30_000 });
    ck("주차 세부 페이지 진입", page.url().includes(firstLink.weekId), page.url());
    await page.waitForFunction(
      () => !document.querySelector("[data-week-detail-title]")?.textContent?.includes("불러오는 중"),
      { timeout: 30_000 },
    ).catch(() => {});
    const wCrumb = (await page.textContent('[aria-label="현재 위치"]'))?.replace(/\s+/g, " ").trim();
    ck("breadcrumb 에 주차명 포함", !!wCrumb && /주차/.test(wCrumb), wCrumb);
    ck("breadcrumb 에 weekId 미노출", !!wCrumb && !wCrumb.includes(firstLink.weekId), wCrumb);
  }

  console.log("\n[4] mode=test 동일 구조");
  await page.goto(`${BASE}${PATH}?mode=test`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-week-row]", { timeout: 30_000 });
  const testCells = await readCells(page);
  ck("mode=test 셀 렌더", testCells.length === cells.length, `${testCells.length}`);
  ck(
    "mode=test 도 3종 상태만",
    testCells.every((c) => ["in_progress", "aggregating", "completed"].includes(c.displayStatus)),
  );
  ck(
    "mode=test 도 활동 유형 표기 동일 어휘",
    testCells.every((c) => KIND_LABELS.some((l) => c.text.includes(l))),
  );

  console.log("\n[5] 조직 열 색상 · 주차 열 너비 (1440/1280/1024 + 다크)");
  for (const vw of [1440, 1280, 1024]) {
    await page.setViewportSize({ width: vw, height: 900 });
    await page.goto(`${BASE}${PATH}?pageSize=20`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-week-row]", { timeout: 30_000 });
    const m = await page.evaluate(() => {
      // Range = 내용의 고유(줄바꿈 없는) 폭. clientWidth 보다 크면 줄바꿈/잘림이 발생한 것.
      const tw = (e) => {
        const r = document.createRange();
        r.selectNodeContents(e);
        return r.getBoundingClientRect().width;
      };
      const overflowing = (sel) =>
        [...document.querySelectorAll(sel)].filter((e) => tw(e) > e.clientWidth + 0.5).length;
      const heads = [...document.querySelectorAll("[data-club-header]")];
      const weekTh = document.querySelector("[data-week-row] th");
      const orgTd = document.querySelector("[data-cell-week]")?.closest("td");
      const table = document.querySelector("table");
      const scroller = table?.closest(".overflow-x-auto");
      const badge = document.querySelector("[data-cell-week] span:last-child");
      return {
        wrapName: overflowing("[data-week-name]"),
        wrapPeriod: overflowing("[data-week-period]"),
        headW: heads.map((e) => Math.round(e.getBoundingClientRect().width)),
        weekW: Math.round(weekTh?.getBoundingClientRect().width ?? 0),
        weekBg: weekTh ? getComputedStyle(weekTh).backgroundColor : null,
        orgBg: orgTd ? getComputedStyle(orgTd).backgroundColor : null,
        orgBorder: orgTd ? getComputedStyle(orgTd).borderLeftWidth : null,
        badgeOpacity: badge ? getComputedStyle(badge).opacity : null,
        pageOverflow:
          document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        tableScrolls: !!scroller && scroller.scrollWidth > scroller.clientWidth + 1,
      };
    });
    ck(`${vw}: 주차명·기간 줄바꿈/잘림 없음`, m.wrapName === 0 && m.wrapPeriod === 0, `${m.wrapName}/${m.wrapPeriod}`);
    ck(`${vw}: 조직 열 너비 동일`, new Set(m.headW).size === 1, m.headW.join("/"));
    // 실측 최소폭(기간 291px + px-3 좌우 24px = 315px) → 19.75rem(316px) 고정. 남는 폭은 조직 열이 가져간다.
    ck(`${vw}: 주차 열 = 316px 고정(팽창 없음)`, m.weekW === 316, `${m.weekW}px`);
    ck(`${vw}: 조직 셀에 조직색 배경`, !!m.orgBg && m.orgBg !== "rgba(0, 0, 0, 0)", String(m.orgBg));
    ck(`${vw}: 조직 열 좌우 경계선`, parseFloat(m.orgBorder ?? "0") > 0, String(m.orgBorder));
    ck(`${vw}: 주차 열엔 조직색 없음`, m.weekBg !== m.orgBg, String(m.weekBg));
    ck(`${vw}: 배지 불투명(상태색 의미 유지)`, m.badgeOpacity === "1", String(m.badgeOpacity));
    ck(`${vw}: 페이지 수평 밀림 없음`, !m.pageOverflow);
    if (vw === 1024) ck("1024: 가로 스크롤은 표 영역에서만", m.tableScrolls);
  }

  // 다크 모드 — 조직색 셀 위 본문 텍스트 대비(WCAG AA 4.5:1).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.classList.add("dark");
  });
  await page.waitForTimeout(300);
  const contrast = await page.evaluate(() => {
    // Tailwind v4 는 lab()/oklch() 를 내보내므로 정규식 파싱 불가 → canvas 로 실제 RGBA 변환.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    const parse = (c) => {
      if (!c) return null;
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (f, b) => [0, 1, 2].map((i) => f[3] * f[i] + (1 - f[3]) * b[i]);
    const lum = (r, g, b) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const cell = document.querySelector("[data-cell-week]");
    const td = cell?.closest("td");
    const bodyBg = parse(getComputedStyle(document.body).backgroundColor) ?? [0, 0, 0, 1];
    const tdBg = parse(td ? getComputedStyle(td).backgroundColor : null);
    const bg = tdBg ? over(tdBg, bodyBg) : bodyBg.slice(0, 3);
    const fg = over(parse(getComputedStyle(cell).color) ?? [255, 255, 255, 1], bg);
    const ratio = (Math.max(lum(...fg), lum(...bg)) + 0.05) / (Math.min(lum(...fg), lum(...bg)) + 0.05);
    return Math.round(ratio * 100) / 100;
  });
  ck("다크: 조직색 셀 위 텍스트 대비 ≥ 4.5", contrast >= 4.5, `ratio=${contrast}`);

  await browser.close();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
