/**
 * /admin/processes/register UI 검증 — READ-ONLY (등록 완료 안 함 → DB 무접촉).
 *   npx tsx --env-file=.env.local scripts/verify-processes-register-ui.mjs
 * 제목 가운데정렬 · 12h 안내문구 · 12h 위반 시 모달 차단(네트워크 미발생) · 개요 미입력 차단
 * · 정렬 라벨 '신청 시점(필요)'·기본값 · 레이아웃 1440/1280/1024 무스크롤.
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

const R = {};
let fails = 0;
const fail = (m) => { fails++; console.log("  FAIL:", m); };

async function main() {
  const ck = await cookies();
  const browser = await chromium.launch({ channel: "chromium" });
  let actPostCount = 0;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(ck);
    const page = await ctx.newPage();
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/processes/acts") && r.method() === "POST") actPostCount++;
    });
    await page.goto(`${baseUrl}/admin/processes/register${query}`, { waitUntil: "networkidle" });
    await page.waitForSelector('text=프로세스 등록');
    console.log(`URL: /admin/processes/register${query}`);

    // 1) 폼 카드 컨테이너가 페이지 기준 가로 가운데 정렬(좌우 여백 균등)
    R.cardCentered = await page.evaluate(() => {
      const title = [...document.querySelectorAll("*")].find(
        (e) => e.children.length === 0 && e.textContent.trim() === "프로세스 등록",
      );
      if (!title) return { ok: false, reason: "title not found" };
      let card = title;
      while (card && !String(card.className || "").includes("max-w-[1040px]")) card = card.parentElement;
      if (!card) return { ok: false, reason: "form card not found" };
      const c = card.getBoundingClientRect();
      const p = card.parentElement.getBoundingClientRect();
      const leftGap = c.left - p.left;
      const rightGap = p.right - c.right;
      return {
        ok: Math.abs(leftGap - rightGap) < 4,
        leftGap: Math.round(leftGap),
        rightGap: Math.round(rightGap),
        cardW: Math.round(c.width),
        parentW: Math.round(p.width),
      };
    });
    if (!R.cardCentered.ok) fail("form card not horizontally centered: " + JSON.stringify(R.cardCentered));

    // 2) 12h 안내 문구
    R.guidance = (await page.locator('text=/최소.*12시간 이후/').count()) > 0;
    if (!R.guidance) fail("12h guidance text missing");

    // 3) 정렬 드롭다운 라벨/기본값
    const sortSel = page.locator('select[aria-label="정렬"]');
    const sortOpts = await sortSel.locator("option").evaluateAll((os) => os.map((o) => o.textContent.trim()));
    const sortDefault = await sortSel.evaluate((s) => s.options[s.selectedIndex].textContent.trim());
    const sortValue = await sortSel.evaluate((s) => s.value);
    R.sort = { options: sortOpts, defaultLabel: sortDefault, defaultValue: sortValue };
    if (!sortOpts.includes("신청 시점(필요)")) fail("sort option '신청 시점(필요)' missing");
    if (sortDefault !== "신청 시점(필요)" || sortValue !== "occur") fail(`sort default wrong: ${sortDefault}/${sortValue}`);

    // 개요 라벨 필수 표시(*)
    R.overviewRequiredMark = await page.locator('label:has-text("개요")').first().evaluate((el) => el.textContent.includes("*")).catch(() => false);
    if (!R.overviewRequiredMark) fail("개요 label missing required *");

    // ── 폼 채우기(등록 완료 안 함): 허브=클럽 → 기존 라인급 선택 → 액트종류 → 개요 ──
    await page.locator('select[aria-label="허브 급"]').selectOption("club");
    await page.waitForTimeout(800); // 라인급 로드
    const chip = page.locator('input[type="checkbox"][aria-label$="선택"]').first();
    const hasGroup = (await chip.count()) > 0;
    R.deepFormTested = hasGroup;
    if (hasGroup) {
      await page.locator('textarea[aria-label="개요"]').fill("QA 개요 텍스트 — 12시간/필수 검증용");
      await page.locator('input[placeholder*="[브리핑]"]').fill("QA 검증 액트");
      await chip.check();
      await page.locator('select[aria-label="액트 종류"]').selectOption("required");

      // (A) 12h 위반(기본 시점 gap=0) → 등록 클릭 → 모달 뜸 + POST 미발생
      const postBefore = actPostCount;
      await page.locator('button:has-text("등록")').last().click();
      await page.waitForSelector('[role="alertdialog"]', { timeout: 4000 });
      const dlgText = await page.locator('[role="alertdialog"]').innerText();
      R.twelveHModalShown = /12시간/.test(dlgText);
      R.twelveHNoNetwork = actPostCount === postBefore;
      if (!R.twelveHModalShown) fail("12h block modal not shown");
      if (!R.twelveHNoNetwork) fail("12h block still fired POST");
      // 모달 닫기
      await page.locator('[role="alertdialog"] button:has-text("확인")').click();
      await page.waitForSelector('[role="alertdialog"]', { state: "detached" });

      // (B) 개요 미입력 → 등록 클릭 → 배너 오류 + POST 미발생 (개요 검증이 12h보다 먼저)
      await page.locator('textarea[aria-label="개요"]').fill("   "); // 공백만
      const postBefore2 = actPostCount;
      await page.locator('button:has-text("등록")').last().click();
      await page.waitForTimeout(500);
      R.overviewEmptyBlocked = (await page.locator('text=개요를 입력해주세요').count()) > 0;
      R.overviewNoNetwork = actPostCount === postBefore2;
      if (!R.overviewEmptyBlocked) fail("empty overview not blocked with message");
      if (!R.overviewNoNetwork) fail("empty overview still fired POST");
    } else {
      console.log("  (club 허브에 라인급 없음 — 심층 폼 검증 스킵)");
    }

    // 4) 레이아웃 + 제목 중앙 유지
    for (const w of [1440, 1280, 1024]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(200);
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: `claudedocs/qa-proc-register-${w}.png`, fullPage: true });
      R[`scroll_${w}`] = sx;
      if (sx > 0) fail(`horizontal scroll at ${w}: ${sx}`);
    }
    R.totalActPosts = actPostCount; // 전체 과정에서 POST 0 이어야
    if (actPostCount !== 0) fail(`unexpected act POST count: ${actPostCount}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log("\n" + JSON.stringify(R, null, 2));
  console.log(`\n${fails === 0 ? "PASS" : "FAIL"}: ${fails} failures`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
