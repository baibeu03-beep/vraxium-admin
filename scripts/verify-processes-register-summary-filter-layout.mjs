/**
 * /admin/processes/register — 요약 통계/필터 레이아웃 검증 (READ-ONLY).
 *   npx tsx --env-file=.env.local scripts/verify-processes-register-summary-filter-layout.mjs
 * 요약 6셀 분산·포인트 A/B/C 무줄바꿈 / 필터 3그룹 분산·돋보기 유지·select 무말줄임 / 무스크롤 / 도움말 비간섭.
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const email = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const query = process.env.PROC_QUERY ?? "";
const E = (n) => { const v = process.env[n]; if (!v) throw new Error("miss " + n); return v; };
async function cookies() {
  const su = E("NEXT_PUBLIC_SUPABASE_URL"), ak = E("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(su, E("SUPABASE_SERVICE_ROLE_KEY")), anon = createClient(su, ak);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({ email, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(su, ak, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

const R = { byWidth: {} };
let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL:", m); };

async function main() {
  const ck = await cookies();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(ck);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/admin/processes/register${query}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=전체 액트 수");
    await page.waitForTimeout(500);
    console.log(`URL: /admin/processes/register${query}`);

    // 요약 6셀 존재
    const labels = ["전체 액트 수", "전체 라인급 수", "총합 소요 시간", "필수 포인트 총합", "우수 포인트 총합", "최대 포인트 총합"];
    for (const l of labels) {
      if ((await page.locator(`text=${l}`).count()) < 1) fail(`summary cell missing: ${l}`);
    }

    // 필터 도움말 3개 유지 + 클릭이 select 를 열지 않음
    const filterHelp = page.locator('span:has-text("정렬") button[aria-label="이 항목 도움말"]').first();
    R.filterHelpPresent = (await page.locator('button[aria-label="이 항목 도움말"]').count()) >= 30;
    // 정렬 도움말 클릭 → 모달 열림, select value 불변
    const sortBefore = await page.locator('select[aria-label="정렬"]').inputValue();
    await filterHelp.click();
    await page.waitForSelector('[role="dialog"]');
    const sortAfter = await page.locator('select[aria-label="정렬"]').inputValue();
    R.helpNoSelectOpen = sortBefore === sortAfter;
    if (!R.helpNoSelectOpen) fail("filter help changed select value");
    await page.locator('[role="dialog"] button[aria-label="닫기"]').click();
    await page.waitForSelector('[role="dialog"]', { state: "detached" });

    async function measure(w) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(250);
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const info = await page.evaluate((labels) => {
        // 요약 박스 = "전체 액트 수" 를 포함하는 grid 컨테이너
        const cellByLabel = (t) => [...document.querySelectorAll("*")].find((e) => e.children.length <= 3 && e.textContent.trim().startsWith(t) && String(e.className).includes("justify-between") && String(e.className).includes("rounded-md"));
        const first = cellByLabel("전체 액트 수");
        const box = first?.parentElement;
        const boxRect = box?.getBoundingClientRect();
        const cells = box ? [...box.children].map((c) => { const r = c.getBoundingClientRect(); return { top: Math.round(r.top), w: Math.round(r.width) }; }) : [];
        const rows = new Set(cells.map((c) => c.top)).size;
        const cols = cells.length ? cells.filter((c) => c.top === cells[0].top).length : 0;
        // 포인트 triplet 줄바꿈 여부 — 높이가 한 줄 수준인지
        const trip = [...document.querySelectorAll("*")].find((e) => String(e.className).includes("grid-cols-3") && String(e.className).includes("min-w-[132px]"));
        const tripH = trip ? Math.round(trip.getBoundingClientRect().height) : 0;
        // 필터 3그룹 분산: 그룹들의 좌표 범위가 컨테이너 폭의 상당 부분을 차지하는지
        const sorts = document.querySelector('select[aria-label="정렬"]');
        const filterBox = sorts?.closest(".grid");
        const fRect = filterBox?.getBoundingClientRect();
        const groups = filterBox ? [...filterBox.children].map((c) => Math.round(c.getBoundingClientRect().left)) : [];
        const spread = fRect && groups.length ? Math.round((groups[groups.length - 1] - groups[0]) / fRect.width * 100) : 0;
        // select 말줄임 여부(정렬): scrollWidth<=clientWidth
        const sortTrunc = sorts ? sorts.scrollWidth > sorts.clientWidth + 1 : false;
        return { boxW: Math.round(boxRect?.width ?? 0), cellCount: cells.length, rows, cols, tripH, filterSpreadPct: spread, sortTrunc };
      }, labels);
      await page.screenshot({ path: `claudedocs/qa-proc-sf-${w}.png`, fullPage: false, clip: { x: 0, y: 0, width: w, height: 1000 } });
      R.byWidth[w] = { pageHScroll: sx, ...info };
      if (sx > 0) fail(`h-scroll at ${w}: ${sx}`);
      if (info.cellCount !== 6) fail(`${w}: summary cells ${info.cellCount} != 6`);
      if (info.tripH > 40) fail(`${w}: point triplet wrapped (h=${info.tripH})`);
      if (info.sortTrunc) fail(`${w}: 정렬 select truncated`);
    }
    for (const w of [1440, 1280, 1024, 768]) await measure(w);
    // 넓은 화면 분산 확인(1440): 필터 그룹이 좌측에 몰리지 않음(spread>=55%)
    if ((R.byWidth[1440].filterSpreadPct ?? 0) < 55) fail(`1440: filters clustered (spread ${R.byWidth[1440].filterSpreadPct}%)`);
    // 1440 요약은 3열 (cols===3)
    if (R.byWidth[1440].cols !== 3) fail(`1440: summary cols ${R.byWidth[1440].cols} != 3`);

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log("\n" + JSON.stringify(R, null, 2));
  console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: ${fails} failures`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
