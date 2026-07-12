// 라인 등록 폼 — URL org 분기 시 소속 조직 드롭다운 숨김 + payload org 고정 검증.
//   POST /api/admin/lines/registrations 는 가로채 mock 으로 응답한다(실제 DB write 없음) → payload 만 확인.
import { chromium, type Page, type BrowserContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function makeAdminCookies() {
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  if (error) throw error;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !le, le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  assert(v.session && !ve, ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return captured.map(({ name, value }) => ({
    name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

// POST 가로채기 — 실제 저장 대신 mock 성공 응답. 마지막으로 캡처한 payload 를 노출.
function installPostInterceptor(context: BrowserContext, capture: { last: any }) {
  return context.route("**/api/admin/lines/registrations", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    try {
      capture.last = JSON.parse(req.postData() ?? "{}");
    } catch {
      capture.last = { __parseError: req.postData() };
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        data: { hubLabel: "실무 정보", lineName: capture.last?.line_name ?? "-", lineCode: capture.last?.line_code ?? "-" },
        pointConfig: { saved: false, configKey: null },
      }),
    });
  });
}

const orgSelect = 'select[aria-label="소속 클럽"]';

async function isOrgDropdownVisible(page: Page): Promise<boolean> {
  return (await page.locator(orgSelect).count()) > 0;
}

async function submitBtn(page: Page) {
  // 가시 텍스트 "등록" 버튼(도움말 아이콘 버튼과 구분).
  return page.locator('button:has-text("등록")').first();
}

async function fillForm(page: Page) {
  // 텍스트 입력은 aria-label 이 없어 placeholder 로 지정한다.
  await page.getByPlaceholder("예) 마케팅 전략 라인").fill("QA scoped-org 검증 라인");
  await page.locator('select[aria-label="소속 허브"]').selectOption("info");
  await page.waitForTimeout(250); // handleHubChange(setLineType) 반영 대기
  // 허브 선택 후 라인 종류를 명시적으로 유효 옵션(index 0)으로 지정 → 검증 통과 보장.
  await page.locator('select[aria-label="라인 종류"]').selectOption({ index: 0 });
  await page.getByPlaceholder("예) WCBS-NL0001").fill("QA-SCOPE-0001");
  // 메인 타이틀 기본 fixed → 값 필요.
  await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("QA 메인 타이틀");
}

// 폼 채우고 제출 → POST 요청을 결정적으로 관찰해 payload 반환(없으면 null=검증에 막힘).
async function fillMinimalAndSubmit(page: Page): Promise<any | null> {
  await fillForm(page);
  const reqP = page
    .waitForRequest(
      (r) => r.url().includes("/api/admin/lines/registrations") && r.method() === "POST",
      { timeout: 8000 },
    )
    .catch(() => null);
  await (await submitBtn(page)).click();
  const req = await reqP;
  if (!req) return null;
  try {
    return JSON.parse(req.postData() ?? "{}");
  } catch {
    return null;
  }
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(cookies);
  const capture = { last: null as any };
  await installPostInterceptor(context, capture);

  let fail = 0;
  const log = (ok: boolean, name: string, extra = "") => {
    if (!ok) fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  };

  // A) 표시/숨김 매트릭스
  const visCases: Array<{ name: string; path: string; expectVisible: boolean; expectNotice?: boolean }> = [
    { name: "통합 register — 드롭다운 표시", path: "/admin/lines/register?tab=register", expectVisible: true },
    { name: "통합 register(쿼리無) — 드롭다운 표시", path: "/admin/lines/register", expectVisible: true },
    { name: "?org=encre — 드롭다운 숨김", path: "/admin/lines/register?org=encre&tab=register", expectVisible: false },
    { name: "?org=oranke — 드롭다운 숨김", path: "/admin/lines/register?org=oranke&tab=register", expectVisible: false },
    { name: "?org=phalanx — 드롭다운 숨김", path: "/admin/lines/register?org=phalanx&tab=register", expectVisible: false },
    { name: "?org=encre&mode=test — 드롭다운 숨김", path: "/admin/lines/register?org=encre&mode=test&tab=register", expectVisible: false },
    { name: "?org=bogus(무효) — 드롭다운 숨김+안내", path: "/admin/lines/register?org=bogus&tab=register", expectVisible: false, expectNotice: true },
  ];
  for (const c of visCases) {
    const page = await context.newPage();
    await page.goto(baseUrl + c.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const visible = await isOrgDropdownVisible(page);
    const noticeShown = (await page.locator("text=유효하지 않은 클럽입니다").count()) > 0;
    let ok = visible === c.expectVisible;
    if (c.expectNotice) ok = ok && noticeShown;
    log(ok, c.name, `visible=${visible} notice=${noticeShown}`);
    await page.close();
  }

  // B) POST payload organizationSlug 고정 (scoped)
  for (const org of ["encre", "oranke", "phalanx"]) {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/admin/lines/register?org=${org}&tab=register`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const payload = await fillMinimalAndSubmit(page);
    const got = payload?.organization_slug;
    log(got === org, `POST payload org 고정 (?org=${org})`, `organization_slug=${JSON.stringify(got)}`);
    await page.close();
  }

  // C) scoped + mode=test → org=encre 고정 & payload 확인
  {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/admin/lines/register?org=encre&mode=test&tab=register`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const payload = await fillMinimalAndSubmit(page);
    const got = payload?.organization_slug;
    const urlHasMode = page.url().includes("mode=test");
    log(got === "encre" && urlHasMode, "scoped+mode=test payload org=encre & mode 보존", `org=${JSON.stringify(got)} url=${page.url()}`);
    await page.close();
  }

  // D) 통합에서 드롭다운 선택 → payload 에 그 값 반영
  {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/admin/lines/register?tab=register`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    await page.locator(orgSelect).selectOption("oranke");
    const payload = await fillMinimalAndSubmit(page);
    const got = payload?.organization_slug;
    log(got === "oranke", "통합에서 드롭다운 선택 → payload 반영", `organization_slug=${JSON.stringify(got)}`);
    await page.close();
  }

  // E) 무효 org → 등록 차단(POST 없음) + 안내 배너
  {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/admin/lines/register?org=bogus&tab=register`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const payload = await fillMinimalAndSubmit(page); // 검증에 막혀 null 이어야 함
    const banner = (await page.locator("text=유효하지 않은 클럽입니다").count()) > 0;
    log(payload === null && banner, "무효 org → 등록 차단(POST 없음)+안내", `posted=${payload !== null} banner=${banner}`);
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("VERIFY ERROR:", e instanceof Error ? e.message : e); process.exit(2); });
