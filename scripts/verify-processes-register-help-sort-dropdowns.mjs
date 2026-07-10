/**
 * /admin/processes/register — 드롭다운 라벨·돋보기 도움말·표 정렬 검증 (READ-ONLY, 등록 안 함).
 *   npx tsx --env-file=.env.local scripts/verify-processes-register-help-sort-dropdowns.mjs
 * native <select> 옵션==선택후표시·raw 미노출 / 돋보기 개수·모달 유지·키 격리 / 표 정렬·도움말 비간섭 / 레이아웃.
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

const R = { dropdowns: [], help: {}, sort: {}, layout: [] };
let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL:", m); };
const RAW = ["N1", "required", "selection", "occur", "none", "check", "club", "info", "experience", "competency", "career", "all", "duration"];

async function main() {
  const ck = await cookies();
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(ck);
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/admin/processes/register${query}`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=프로세스 등록");
    await page.waitForTimeout(600);
    console.log(`URL: /admin/processes/register${query}`);

    // 허브 선택(폼 select 활성화 + addLineGroup 도움말 노출)
    await page.locator('select[aria-label="허브 급"]').selectOption("club");
    await page.waitForTimeout(700);

    // ── 드롭다운: 옵션==선택후표시, raw 미노출 ──
    async function checkSelect(aria, pickValue) {
      const sel = page.locator(`select[aria-label="${aria}"]`);
      if ((await sel.count()) === 0) return;
      const opts = await sel.locator("option").evaluateAll((os) => os.map((o) => ({ value: o.value, text: (o.textContent || "").trim() })));
      const target = opts.find((o) => o.value === pickValue) ?? opts.find((o) => o.text !== "-" && o.text !== "선택");
      await sel.selectOption(target.value);
      const displayed = await sel.evaluate((s) => s.options[s.selectedIndex].textContent.trim());
      const raw = RAW.includes(displayed);
      const match = displayed === target.text; // native select: 옵션 textContent == 트리거 표시
      R.dropdowns.push({ field: aria, value: target.value, optionText: target.text, displayed, match, rawLeak: raw });
      if (!match) fail(`${aria}: option '${target.text}' != displayed '${displayed}'`);
      if (raw) fail(`${aria}: raw code displayed '${displayed}'`);
    }
    await checkSelect("허브 급", "club");        // 클럽 총괄 급
    await checkSelect("신청 주", "N1");          // value N1 → "N+1"
    await checkSelect("신청 요일", "1");          // value 1 → "월"
    await checkSelect("검수 주", "N1");
    await checkSelect("액트 종류", "required");   // value required → "필수"
    await checkSelect("카페", "none");            // value none → "미발생"
    await checkSelect("체크 대상", "none");        // value none → "미체크"
    await checkSelect("허브 급 필터", "club");
    await checkSelect("정렬", "duration");         // → "소요 시간 순"
    await checkSelect("필터", "required");         // → "필수"

    // ── 돋보기 개수 ──
    const magCount = await page.locator('button[aria-label="이 항목 도움말"]').count();
    R.help.rendered = magCount;
    console.log(`magnifiers: ${magCount}`);
    if (magCount < 30) fail(`too few magnifiers: ${magCount}`);

    // ── 표 정렬: sortable 헤더 존재 + 정렬 동작 + 비정렬 컬럼(번호/삭제) 정렬버튼 없음+도움말 유지 ──
    const sortBtns = page.locator('th button[aria-label$="정렬"]');
    R.sort.columns = await sortBtns.count();
    if (R.sort.columns !== 12) fail(`expected 12 sortable columns, got ${R.sort.columns}`);
    for (const noSort of ["번호", "삭제"]) {
      const b = await page.locator(`th button[aria-label="${noSort} 정렬"]`).count();
      const h = await page.locator(`th:has-text("${noSort}") button[aria-label="이 항목 도움말"]`).count();
      if (b !== 0) fail(`${noSort} still sortable`);
      if (h < 1) fail(`${noSort} lost help icon`);
    }
    // 액트명 정렬(오름/내림) 동작
    const rowCount = await page.locator("tbody tr").count();
    R.sort.rowCount = rowCount;
    if (rowCount >= 2) {
      const nameCell = () => page.locator("tbody tr").first().locator("td").nth(2); // 액트명 = 3번째 컬럼(0-idx 2)
      const readCol = async () => { const out = []; const n = Math.min(await page.locator("tbody tr").count(), 8); for (let i = 0; i < n; i++) out.push((await page.locator("tbody tr").nth(i).locator("td").nth(2).innerText()).trim()); return out; };
      const btn = page.locator('th button[aria-label="액트명 정렬"]');
      await btn.click(); await page.waitForTimeout(150);
      const asc = await readCol();
      R.sort.ascOk = JSON.stringify(asc) === JSON.stringify([...asc].sort((a, b) => a.localeCompare(b, "ko")));
      if (!R.sort.ascOk) fail("asc sort mismatch");
      await btn.click(); await page.waitForTimeout(150);
      const desc = await readCol();
      R.sort.descOk = JSON.stringify(desc) === JSON.stringify([...desc].sort((a, b) => b.localeCompare(a, "ko")));
      if (!R.sort.descOk) fail("desc sort mismatch");
      // 도움말↔정렬 비간섭: 액트명 헤더 돋보기 클릭 → 모달 열림 + 순서 불변
      const before = await nameCell().innerText();
      await page.locator('th:has(button[aria-label="액트명 정렬"]) button[aria-label="이 항목 도움말"]').click();
      await page.waitForSelector('[role="dialog"]');
      R.sort.helpDoesNotSort = (await nameCell().innerText()) === before;
      if (!R.sort.helpDoesNotSort) fail("help click changed sort");
      await page.locator('[role="dialog"] button[aria-label="닫기"]').click();
      await page.waitForSelector('[role="dialog"]', { state: "detached" });
      await btn.click(); await page.waitForTimeout(150); // 기본 복귀
    }

    // ── 도움말 편집→저장→재조회 유지 + 키 격리 (원문 복원) ──
    const token = `QA-PROC-${Date.now()}`;
    async function openHelp(label) {
      const getDone = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "GET", { timeout: 8000 });
      await page.locator(`label:has-text("${label}")`).first().locator("xpath=..").locator('button[aria-label="이 항목 도움말"]').click();
      await page.waitForSelector('[role="dialog"]');
      await getDone.catch(() => {});
      await page.waitForTimeout(200);
    }
    const closeHelp = async () => { await page.locator('[role="dialog"] button[aria-label="닫기"]').click(); await page.waitForSelector('[role="dialog"]', { state: "detached" }); };
    async function saveHelp(text) {
      await page.locator('[role="dialog"] button:has-text("편집")').click();
      await page.locator('[role="dialog"] textarea').fill(text);
      const put = page.waitForResponse((r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT" && r.status() === 200, { timeout: 8000 });
      await page.locator('[role="dialog"] button:has-text("저장")').click();
      await put; await page.waitForTimeout(150);
    }
    await openHelp("액트명");
    const orig = (await page.locator('[role="dialog"]').innerText()).includes("등록된 도움말이 없습니다") ? "" : await page.locator('[role="dialog"] .whitespace-pre-wrap').innerText().catch(() => "");
    await saveHelp(token); await closeHelp();
    await openHelp("액트명");
    R.help.persistsReopen = (await page.locator('[role="dialog"]').innerText()).includes(token);
    if (!R.help.persistsReopen) fail("help not persisted after reopen");
    await closeHelp();
    await page.reload({ waitUntil: "networkidle" }); await page.waitForTimeout(500);
    await page.locator('select[aria-label="허브 급"]').selectOption("club"); await page.waitForTimeout(400);
    await openHelp("액트명");
    R.help.persistsReload = (await page.locator('[role="dialog"]').innerText()).includes(token);
    if (!R.help.persistsReload) fail("help not persisted after reload");
    await closeHelp();
    await openHelp("허브 급"); // 다른 키
    R.help.keyIsolation = !(await page.locator('[role="dialog"]').innerText()).includes(token);
    if (!R.help.keyIsolation) fail("key isolation broken");
    await closeHelp();
    await openHelp("액트명"); await saveHelp(orig); await closeHelp(); // 복원
    R.help.restored = true;

    // ── 레이아웃 + 액트명 말줄임 여부 ──
    for (const w of [1440, 1280, 1024, 768]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(200);
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: `claudedocs/qa-proc-reg2-${w}.png`, fullPage: false, clip: { x: 0, y: 0, width: w, height: Math.min(1000, 1400) } });
      R.layout.push({ width: w, pageHScroll: sx });
      if (sx > 0) fail(`page horizontal scroll at ${w}: ${sx}`);
    }
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log("\n" + JSON.stringify(R, null, 2));
  console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: ${fails} failures`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
