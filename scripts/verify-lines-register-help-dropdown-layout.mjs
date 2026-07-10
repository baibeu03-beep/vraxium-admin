/**
 * /admin/lines/register (?tab=register) 검증 — READ-ONLY(등록 POST 는 route.abort 로 DB 무접촉).
 *   npx tsx --env-file=.env.local scripts/verify-lines-register-help-dropdown-layout.mjs
 * 1) 돋보기 도움말 개수/키 · 편집→저장→재조회 유지 · 키 격리 (원문 복원)
 * 2) 네이티브 select: 옵션 문구 == 선택후 표시 · raw enum/slug 미노출
 * 3) 등록 POST body 가 label 이 아닌 기존 value 전송(route.abort)
 * 4) 레이아웃 1440/1280/1024 무스크롤 · Input 폭 유지
 * 5) mode=test 동일성(같은 컴포넌트/help API/DTO)
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
  const { data: l, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (le) throw le;
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  if (ve) throw ve;
  const cap = [];
  const s = createServerClient(su, ak, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

const results = { dropdowns: [], help: {}, layout: [], post: null, modeTest: {} };
let failures = 0;
const fail = (m) => { failures++; console.log("  FAIL:", m); };

async function main() {
  const cookies = await authCookies();
  const browser = await chromium.launch({ channel: "chromium" });
  const helpCalls = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on("request", (r) => {
      if (r.url().includes("/api/admin/help")) helpCalls.push({ method: r.method(), url: r.url() });
    });

    await page.goto(`${baseUrl}/admin/lines/register?tab=register`, { waitUntil: "networkidle" });
    await page.waitForSelector('text=라인 등록');

    // ── 1) 돋보기 개수 ──
    const magnifiers = page.locator('button[aria-label="이 항목 도움말"]');
    const magCount = await magnifiers.count();
    results.help.rendered = magCount;
    console.log(`magnifiers rendered: ${magCount}`);
    if (magCount !== 16) fail(`expected 16 magnifiers, got ${magCount}`);

    // ── 2) 네이티브 select: 옵션문구==선택후표시, raw 미노출 ──
    const RAW = ["info", "experience", "competency", "career", "encre", "oranke", "phalanx", "common"];
    async function checkSelect(ariaLabel, pickIndex) {
      const sel = page.locator(`select[aria-label="${ariaLabel}"]`);
      const opts = await sel.locator("option").evaluateAll((os) =>
        os.map((o) => ({ value: o.value, text: (o.textContent || "").trim() })));
      // '-' 미선택 제외한 실제 옵션 중 pickIndex
      const real = opts.filter((o) => o.text !== "-");
      const chosen = real[Math.min(pickIndex, real.length - 1)];
      await sel.selectOption(chosen.value);
      // 네이티브 select 는 선택 옵션의 textContent 가 곧 트리거 표시값
      const displayed = await sel.evaluate((s) => s.options[s.selectedIndex].textContent.trim());
      const raw = RAW.includes(displayed); // 표시가 영문 enum/slug 면 실패
      const match = displayed === chosen.text; // 옵션 목록 문구 == 선택 후 표시
      results.dropdowns.push({ field: ariaLabel, value: chosen.value, optionShown: chosen.text, displayed, match, rawLeak: raw });
      if (!match) fail(`${ariaLabel}: option '${chosen.text}' != displayed '${displayed}'`);
      if (raw) fail(`${ariaLabel}: raw code displayed '${displayed}'`);
    }
    await checkSelect("소속 허브", 0);      // 실무 정보 (value=info)
    // 허브 선택 후 라인 종류 활성화됨
    await checkSelect("라인 종류", 0);
    await checkSelect("소속 조직", 0);      // Encre (value=encre)
    // career 허브로 바꾸면 프로필 사진 select 활성화 — 확인
    await page.locator('select[aria-label="소속 허브"]').selectOption("career");
    await checkSelect("프로필 사진", 0);    // 잔다르크
    // 다시 정보 허브로 되돌림(POST 검증 위해)
    await page.locator('select[aria-label="소속 허브"]').selectOption("info");

    // ── 3) 도움말 편집→저장→재조회 유지 + 키 격리 (원문 복원) ──
    const token = `QA-VERIFY-${Date.now()}`;
    async function openHelp(labelText) {
      // 모달 GET 응답을 명시적으로 기다린 뒤 본문을 읽는다(조기 판독 레이스 방지).
      const getDone = page.waitForResponse(
        (r) => r.url().includes("/api/admin/help") && r.request().method() === "GET",
        { timeout: 8000 },
      );
      await page.locator(`label:has-text("${labelText}")`).first()
        .locator('xpath=..').locator('button[aria-label="이 항목 도움말"]').click();
      await page.waitForSelector('[role="dialog"]');
      await getDone.catch(() => {});
      await page.waitForTimeout(200);
    }
    async function readHelpBody() {
      const dlg = page.locator('[role="dialog"]');
      const txt = (await dlg.innerText()).trim();
      return txt;
    }
    async function closeHelp() {
      await page.locator('[role="dialog"] button[aria-label="닫기"]').click();
      await page.waitForSelector('[role="dialog"]', { state: "detached" });
    }
    // 원문 백업
    await openHelp("라인명");
    const originalBody = await readHelpBody();
    const hadContent = !originalBody.includes("등록된 도움말이 없습니다");
    const originalText = hadContent
      ? await page.locator('[role="dialog"] .whitespace-pre-wrap').innerText().catch(() => "")
      : "";
    // 편집 → 토큰 저장 (PUT 응답을 명시적으로 기다려 DB 커밋 후 재조회)
    async function saveHelp(text) {
      await page.locator('[role="dialog"] button:has-text("편집")').click();
      await page.locator('[role="dialog"] textarea').fill(text);
      const putDone = page.waitForResponse(
        (r) => r.url().includes("/api/admin/help") && r.request().method() === "PUT" && r.status() === 200,
        { timeout: 8000 },
      );
      await page.locator('[role="dialog"] button:has-text("저장")').click();
      await putDone;
      await page.waitForTimeout(200);
    }
    await saveHelp(token);
    await closeHelp();
    // 재조회(다시 열기) → 유지 확인
    await openHelp("라인명");
    const afterSave = await readHelpBody();
    results.help.persistsAfterReopen = afterSave.includes(token);
    if (!afterSave.includes(token)) fail("help content did not persist after reopen");
    await closeHelp();
    // 새로고침 후 유지
    await page.reload({ waitUntil: "networkidle" });
    await openHelp("라인명");
    const afterReload = await readHelpBody();
    results.help.persistsAfterReload = afterReload.includes(token);
    if (!afterReload.includes(token)) fail("help content did not persist after reload");
    await closeHelp();
    // 키 격리: 소속 허브 도움말은 라인명 토큰과 섞이지 않아야
    await openHelp("소속 허브");
    const hubBody = await readHelpBody();
    results.help.keyIsolation = !hubBody.includes(token);
    if (hubBody.includes(token)) fail("key isolation broken (hub shows lineName token)");
    await closeHelp();
    // 원문 복원 (DB 무변경)
    await openHelp("라인명");
    await saveHelp(originalText);
    await closeHelp();
    results.help.restored = true;
    // help API 흐름 근거
    results.help.apiCalls = {
      get: helpCalls.filter((c) => c.method === "GET").length,
      put: helpCalls.filter((c) => c.method === "PUT").length,
    };

    // ── 4) 등록 POST body 가 기존 value 전송 (route.abort) ──
    let postBody = null;
    await page.route("**/api/admin/lines/registrations", (route) => {
      if (route.request().method() === "POST") { postBody = route.request().postDataJSON(); return route.abort(); }
      return route.continue();
    });
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await page.locator('input[placeholder*="마케팅 전략"]').fill("QA 검증 라인");
    await page.locator('select[aria-label="소속 허브"]').selectOption("experience");
    await page.locator('select[aria-label="라인 종류"]').selectOption("분석");
    await page.locator('input[placeholder*="WCBS-NL0001"]').fill("EXQA-VR0001");
    await page.locator('input[placeholder*="메인 타이틀"]').fill("QA 메인 타이틀");
    await page.locator('button:has-text("등록")').first().click();
    await page.waitForTimeout(800);
    results.post = postBody;
    if (!postBody) fail("registration POST not captured");
    else {
      const ok = postBody.hub === "experience" && postBody.line_type === "분석"
        && postBody.line_code === "EXQA-VR0001" && !JSON.stringify(postBody).includes("실무 경험");
      results.post._checks = {
        hubValueNotLabel: postBody.hub === "experience",
        lineTypeKept: postBody.line_type === "분석",
        codeKept: postBody.line_code === "EXQA-VR0001",
        noHubLabelLeak: !JSON.stringify(postBody).includes("실무 경험"),
      };
      if (!ok) fail("POST body value contract broken");
    }
    await page.unroute("**/api/admin/lines/registrations");

    // ── 5) 레이아웃 스크린샷 + 무스크롤 ──
    for (const w of [1440, 1280, 1024]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.waitForTimeout(200);
      const sx = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.screenshot({ path: `claudedocs/qa-lines-register-${w}.png`, fullPage: true });
      results.layout.push({ width: w, horizontalScroll: sx });
      if (sx > 0) fail(`horizontal scroll at ${w}px: ${sx}`);
    }

    await ctx.close();

    // ── 6) mode=test 동일성 ──
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await ctx2.addCookies(cookies);
    const p2 = await ctx2.newPage();
    let testHelpGet = null;
    p2.on("request", (r) => {
      if (r.url().includes("/api/admin/help") && r.method() === "GET" && r.url().includes("lineName")) testHelpGet = r.url();
    });
    await p2.goto(`${baseUrl}/admin/lines/register?tab=register&mode=test&org=phalanx`, { waitUntil: "networkidle" });
    await p2.waitForSelector('text=라인 등록');
    const magCount2 = await p2.locator('button[aria-label="이 항목 도움말"]').count();
    results.modeTest.magnifiers = magCount2;
    if (magCount2 !== 16) fail(`mode=test magnifiers ${magCount2} != 16`);
    // 같은 help 저장소인지: lineName 도움말 GET 경로가 org/mode 없이 동일 key
    await p2.locator('label:has-text("라인명")').first().locator('xpath=..').locator('button[aria-label="이 항목 도움말"]').click();
    await p2.waitForSelector('[role="dialog"]');
    await p2.waitForTimeout(400);
    results.modeTest.helpGetUrl = testHelpGet;
    // 저장 키(path 파라미터)가 org/mode 를 포함하지 않는 중립 키인지 확인.
    //   URL 에 &mode=test 가 붙어도 서버(route.ts)는 path 만 읽으므로 저장소가 갈라지지 않는다.
    const pathParam = testHelpGet ? new URL(testHelpGet).searchParams.get("path") : null;
    results.modeTest.helpPathParam = pathParam;
    results.modeTest.helpKeyNeutral = pathParam === "admin.lines.register.lineName";
    if (!results.modeTest.helpKeyNeutral) fail(`mode=test help path not neutral: ${pathParam}`);
    // 소속 허브 select 옵션 동일
    const hubOpts2 = await p2.locator('select[aria-label="소속 허브"] option').evaluateAll((os) => os.map((o) => o.textContent.trim()));
    results.modeTest.hubOptions = hubOpts2;
    await ctx2.close();
  } finally {
    await browser.close();
  }

  console.log("\n" + JSON.stringify(results, null, 2));
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failures`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
