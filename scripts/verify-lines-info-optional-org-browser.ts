// 라인 정보 optional-org 복원 브라우저 검증.
//   정책: org 없음=통합(전체 조직) 화면 · org 있음=해당 조직 화면. 안내 박스 폐지.
//   서버 redirect 로 기본 org 를 강제하지 않는다(lines 만 통합 컨텍스트 유지).
//
// 검증 신호:
//   · 최종 URL(redirect 여부) — 통합 진입 시 org 가 새로 붙지 않아야 함.
//   · 안내 박스 문구 부재("조직을 선택하면 라인 정보가 표시됩니다").
//   · 라인 정보 화면 존재 = 클럽 필터 select(aria-label="클럽 필터").
//   · 클럽 옵션 수: 통합=5(-,엥크레,오랑캐,팔랑크스,공통) · 조직=2(-, 해당 org).
//   · 콘솔 error / pageerror 0.
import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SHOT_DIR = "claudedocs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (adminError) throw adminError;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

const PLACEHOLDER = "클럽을 선택하면 라인 정보가 표시됩니다";

type Probe = {
  name: string;
  path: string;
  clickSequence?: string[]; // 탭 라벨 클릭 순서(왕복 검증)
  expect: {
    redirectFreeFrom?: string; // 이 경로로 진입했는데 org 가 붙어 redirect 되면 실패
    orgNotAppended?: boolean; // 최종 URL 에 org= 가 없어야 함
    infoScreen?: boolean; // 클럽 필터 존재해야
    clubOptionCount?: number; // 정확한 옵션 수
    registerScreen?: boolean; // 등록 화면(클럽 필터 없음)
    orgParam?: string; // 최종 URL org= 값
    modeParam?: string; // 최종 URL mode= 값
  };
};

async function collect(page: Page) {
  const clubFilter = page.locator('select[aria-label="클럽 필터"]');
  const hasInfo = (await clubFilter.count()) > 0;
  let clubOpts = 0;
  if (hasInfo) clubOpts = await clubFilter.locator("option").count();
  const bodyText = (await page.locator("body").innerText()).slice(0, 20000);
  return {
    url: page.url(),
    hasInfo,
    clubOpts,
    hasPlaceholder: bodyText.includes(PLACEHOLDER),
  };
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(cookies);

  const probes: Probe[] = [
    {
      name: "1. /admin/lines/info (통합)",
      path: "/admin/lines/info",
      expect: { orgNotAppended: true, infoScreen: true, clubOptionCount: 5 },
    },
    {
      name: "2. /admin/lines/register?tab=info (통합)",
      path: "/admin/lines/register?tab=info",
      expect: { orgNotAppended: true, infoScreen: true, clubOptionCount: 5 },
    },
    {
      name: "3. /admin/lines/register (등록)",
      path: "/admin/lines/register",
      expect: { registerScreen: true, orgNotAppended: true },
    },
    {
      name: "5. /admin/lines/info?org=encre",
      path: "/admin/lines/info?org=encre",
      expect: { infoScreen: true, clubOptionCount: 2, orgParam: "encre" },
    },
    {
      name: "6. /admin/lines/info?org=oranke",
      path: "/admin/lines/info?org=oranke",
      expect: { infoScreen: true, clubOptionCount: 2, orgParam: "oranke" },
    },
    {
      name: "7. /admin/lines/info?org=phalanx",
      path: "/admin/lines/info?org=phalanx",
      expect: { infoScreen: true, clubOptionCount: 2, orgParam: "phalanx" },
    },
    {
      name: "8. ?org=encre&mode=test",
      path: "/admin/lines/info?org=encre&mode=test",
      expect: { infoScreen: true, clubOptionCount: 2, orgParam: "encre", modeParam: "test" },
    },
  ];

  let fail = 0;
  for (const probe of probes) {
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    await page.goto(baseUrl + probe.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const r = await collect(page);
    const u = new URL(r.url);
    const orgParam = u.searchParams.get("org");
    const modeParam = u.searchParams.get("mode");

    const problems: string[] = [];
    if (r.hasPlaceholder) problems.push("안내 박스 표시됨(폐지 대상)");
    if (probe.expect.orgNotAppended && orgParam) problems.push(`org 강제 부착됨(${orgParam})`);
    if (probe.expect.orgParam && orgParam !== probe.expect.orgParam)
      problems.push(`org=${orgParam} (기대 ${probe.expect.orgParam})`);
    if (probe.expect.modeParam && modeParam !== probe.expect.modeParam)
      problems.push(`mode=${modeParam} (기대 ${probe.expect.modeParam})`);
    if (probe.expect.infoScreen && !r.hasInfo) problems.push("라인 정보 화면 없음(클럽 필터 부재)");
    if (probe.expect.registerScreen && r.hasInfo) problems.push("등록 화면인데 클럽 필터 존재");
    if (probe.expect.clubOptionCount != null && r.clubOpts !== probe.expect.clubOptionCount)
      problems.push(`클럽 옵션 ${r.clubOpts}개 (기대 ${probe.expect.clubOptionCount})`);
    if (consoleErrors.length) problems.push(`console/pageerror ${consoleErrors.length}건: ${consoleErrors.slice(0, 2).join(" | ")}`);

    const shot = `${SHOT_DIR}/verify-lines-info-optorg-${probe.name.split(".")[0].trim()}.png`;
    await page.screenshot({ path: shot, fullPage: false });

    if (problems.length) fail++;
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${probe.name}`);
    console.log(`      url=${r.url}`);
    console.log(`      info=${r.hasInfo} clubOpts=${r.clubOpts} placeholder=${r.hasPlaceholder}`);
    if (problems.length) console.log("      ✗ " + problems.join(" · "));
    await page.close();
  }

  // 4. 통합 왕복: register → info → register, org 미부착 확인.
  {
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));
    await page.goto(baseUrl + "/admin/lines/register", { waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await page.getByRole("link", { name: "라인 정보" }).first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    const afterInfo = await collect(page);
    await page.getByRole("link", { name: "라인 등록" }).first().click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    const afterReg = await collect(page);
    const problems: string[] = [];
    if (new URL(afterInfo.url).searchParams.get("org")) problems.push(`info 왕복서 org 부착(${afterInfo.url})`);
    if (!afterInfo.hasInfo) problems.push("info 탭 클릭 후 라인 정보 화면 없음");
    if (afterInfo.clubOpts !== 5) problems.push(`info 왕복 클럽옵션 ${afterInfo.clubOpts} (기대 5=통합)`);
    if (new URL(afterReg.url).searchParams.get("org")) problems.push(`register 왕복서 org 부착(${afterReg.url})`);
    if (afterInfo.hasPlaceholder) problems.push("왕복 info 안내박스");
    if (consoleErrors.length) problems.push(`console ${consoleErrors.length}건`);
    if (problems.length) fail++;
    console.log(`${problems.length ? "FAIL" : "PASS"}  4. 통합 왕복 register→info→register`);
    console.log(`      info.url=${afterInfo.url} (clubOpts=${afterInfo.clubOpts})`);
    console.log(`      reg.url=${afterReg.url}`);
    if (problems.length) console.log("      ✗ " + problems.join(" · "));
    await page.screenshot({ path: `${SHOT_DIR}/verify-lines-info-optorg-4-roundtrip.png` });
    await page.close();
  }

  await browser.close();
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("VERIFY ERROR:", e instanceof Error ? e.message : e);
  process.exit(2);
});
