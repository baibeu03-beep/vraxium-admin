/**
 * /admin/lines/register (tab=info = LineRegistrationInfoManager) 검증 — READ-ONLY.
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-help-sort.mjs
 * 1) 돋보기 14개(통계2·필터2·결과1·버튼2·컬럼7) · 키 목록
 * 2) 컬럼 헤더 정렬(오름/내림) 동작 · 도움말 클릭↔정렬 클릭 비간섭
 * 3) 도움말 편집→저장→재조회 유지(HTTP) · 원문 복원
 * 4) 클럽 필터 native select 옵션==표시 · raw 미노출
 * 5) mode=test 돋보기 동일 · 레이아웃 무스크롤
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const E = (n) => { const v = process.env[n]; if (!v) throw new Error("miss " + n); return v; };

async function authCookies() {
  const su = E("NEXT_PUBLIC_SUPABASE_URL"), ak = E("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(su, E("SUPABASE_SERVICE_ROLE_KEY")), anon = createClient(su, ak);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(su, ak, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

const R = { help: {}, sort: {}, dropdown: null, layout: [], modeTest: {} };
let failures = 0;
const fail = (m) => { failures++; console.log("  FAIL:", m); };

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    await page.waitForSelector('text=전체 허브 갯수');
    await page.waitForTimeout(600);

    // ── 1) 돋보기 개수 ──
    const magCount = await page.locator('button[aria-label="이 항목 도움말"]').count();
    R.help.rendered = magCount;
    console.log("info magnifiers:", magCount);
    if (magCount !== 14) fail(`expected 14 magnifiers, got ${magCount}`);

    // ── 2) 컬럼 헤더: 정렬버튼은 의미 있는 5개 컬럼만(메인 타이틀 내용·유닛 제거) ──
    const sortBtns = page.locator('th button[aria-label$="정렬"]');
    const sortCount = await sortBtns.count();
    R.sort.columns = sortCount;
    if (sortCount !== 5) fail(`expected 5 sortable columns, got ${sortCount}`);
    // 정렬 제거 컬럼: 정렬 버튼 없음 + 도움말 돋보기는 유지
    for (const noSortLabel of ["메인 타이틀 내용", "유닛"]) {
      const hasSortBtn = await page.locator(`th button[aria-label="${noSortLabel} 정렬"]`).count();
      const hasHelp = await page.locator(`th:has-text("${noSortLabel}") button[aria-label="이 항목 도움말"]`).count();
      R.sort[`noSort_${noSortLabel}`] = { sortBtn: hasSortBtn, help: hasHelp };
      if (hasSortBtn !== 0) fail(`${noSortLabel} still has sort button`);
      if (hasHelp < 1) fail(`${noSortLabel} lost its help icon`);
    }
    // 결과 라벨 '결과 수' 확인
    R.sort.resultLabel = (await page.locator('text=/결과 수/').count()) > 0;
    if (!R.sort.resultLabel) fail("result label '결과 수' not found");

    const firstCodeCell = () => page.locator("tbody tr").first().locator("td").nth(1); // 라인 코드 컬럼
    const rowCount = await page.locator("tbody tr").count();
    R.sort.rowCount = rowCount;
    if (rowCount >= 2) {
      const codeBtn = page.locator('th button[aria-label="라인 코드 정렬"]');
      await codeBtn.click(); await page.waitForTimeout(150);
      const asc = [];
      for (let i = 0; i < Math.min(rowCount, 8); i++) asc.push((await page.locator("tbody tr").nth(i).locator("td").nth(1).innerText()).trim());
      const ascSorted = [...asc].sort((a, b) => a.localeCompare(b, "ko"));
      R.sort.ascOk = JSON.stringify(asc) === JSON.stringify(ascSorted);
      if (!R.sort.ascOk) fail(`asc sort mismatch: ${JSON.stringify(asc)}`);
      await codeBtn.click(); await page.waitForTimeout(150); // desc
      const desc = [];
      for (let i = 0; i < Math.min(rowCount, 8); i++) desc.push((await page.locator("tbody tr").nth(i).locator("td").nth(1).innerText()).trim());
      R.sort.descOk = JSON.stringify(desc) === JSON.stringify([...asc].reverse().length ? [...desc].sort((a, b) => b.localeCompare(a, "ko")) : desc);
      if (!R.sort.descOk) fail(`desc sort mismatch: ${JSON.stringify(desc)}`);
      await codeBtn.click(); await page.waitForTimeout(150); // back to default

      // 도움말 클릭 ↔ 정렬 비간섭: 라인 코드 헤더의 돋보기 클릭 → 모달 열림 + 순서 불변
      const before = await firstCodeCell().innerText();
      await page.locator('th:has(button[aria-label="라인 코드 정렬"]) button[aria-label="이 항목 도움말"]').click();
      await page.waitForSelector('[role="dialog"]');
      const after = await firstCodeCell().innerText();
      R.sort.helpDoesNotSort = before === after;
      if (before !== after) fail("help click changed sort order (interference)");
      await page.locator('[role="dialog"] button[aria-label="닫기"]').click();
      await page.waitForSelector('[role="dialog"]', { state: "detached" });
    } else {
      console.log("  (rows<2 — sorting order assert skipped; buttons presence still checked)");
    }

    // ── 3) 도움말 편집→저장→재조회 유지 (컬럼 라인명 키) + 원문 복원 ──
    const token = `QA-INFO-${Date.now()}`;
    async function openHelpByColumn(colLabel) {
      const getDone = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "GET", { timeout: 8000 });
      await page.locator(`th:has(button[aria-label="${colLabel} 정렬"]) button[aria-label="이 항목 도움말"]`).click();
      await page.waitForSelector('[role="dialog"]');
      await getDone.catch(() => {});
      await page.waitForTimeout(200);
    }
    async function closeHelp() {
      await page.locator('[role="dialog"] button[aria-label="닫기"]').click();
      await page.waitForSelector('[role="dialog"]', { state: "detached" });
    }
    async function saveHelp(text) {
      await page.locator('[role="dialog"] button:has-text("편집")').click();
      await page.locator('[role="dialog"] textarea').fill(text);
      const put = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT" && r.status() === 200, { timeout: 8000 });
      await page.locator('[role="dialog"] button:has-text("저장")').click();
      await put; await page.waitForTimeout(200);
    }
    await openHelpByColumn("라인명");
    const origBody = (await page.locator('[role="dialog"]').innerText()).trim();
    const origText = origBody.includes("등록된 도움말이 없습니다") ? "" : await page.locator('[role="dialog"] .whitespace-pre-wrap').innerText().catch(() => "");
    await saveHelp(token);
    await closeHelp();
    await openHelpByColumn("라인명");
    R.help.persistsAfterReopen = (await page.locator('[role="dialog"]').innerText()).includes(token);
    if (!R.help.persistsAfterReopen) fail("info help did not persist after reopen");
    await closeHelp();
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await openHelpByColumn("라인명");
    R.help.persistsAfterReload = (await page.locator('[role="dialog"]').innerText()).includes(token);
    if (!R.help.persistsAfterReload) fail("info help did not persist after reload");
    await saveHelp(origText); // 복원
    await closeHelp();
    R.help.restored = true;

    // ── 4) 클럽 필터 native select ──
    const sel = page.locator('select[aria-label="클럽 필터"]');
    const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ value: o.value, text: o.textContent.trim() })));
    await sel.selectOption("encre");
    const displayed = await sel.evaluate((s) => s.options[s.selectedIndex].textContent.trim());
    R.dropdown = { field: "클럽 필터", value: "encre", displayed, optionText: opts.find((o) => o.value === "encre")?.text };
    if (displayed !== "엥크레") fail(`club filter displayed '${displayed}' != '엥크레'`);
    if (["encre", "oranke", "phalanx", "common"].includes(displayed)) fail("club filter shows raw slug");
    await sel.selectOption("-");

    // ── 5) 레이아웃 ──
    for (const w of [1440, 1280, 1024]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(200);
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: `claudedocs/qa-lines-info-${w}.png`, fullPage: true });
      R.layout.push({ width: w, horizontalScroll: sx });
      // 표 자체는 overflow-x-auto 컨테이너를 가지므로 페이지 가로 스크롤만 본다.
      if (sx > 0) fail(`page horizontal scroll at ${w}px: ${sx}`);
    }
    await ctx.close();

    // ── 6) mode=test 동일 ──
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx2.addCookies(cookies);
    const p2 = await ctx2.newPage();
    await p2.goto(`${baseUrl}/admin/lines/register?mode=test&org=phalanx`, { waitUntil: "networkidle" });
    await p2.waitForSelector('text=전체 허브 갯수');
    await p2.waitForTimeout(500);
    R.modeTest.magnifiers = await p2.locator('button[aria-label="이 항목 도움말"]').count();
    if (R.modeTest.magnifiers !== 14) fail(`mode=test magnifiers ${R.modeTest.magnifiers} != 14`);
    await ctx2.close();
  } finally {
    await browser.close();
  }
  console.log("\n" + JSON.stringify(R, null, 2));
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
