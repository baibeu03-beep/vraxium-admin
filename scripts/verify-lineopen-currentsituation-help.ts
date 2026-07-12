import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening/* — 이번 수정분 HTTP+브라우저 검증.
//   요청 항목:
//    1) 상단 CardDescription "선택 주차의 실무 정보 라인 개설 상황..." + 그 옆 도움말 버튼이 사라짐(info).
//    2) "현재 상황" 카드 제목 옆에 도움말 버튼 표시 + 클릭 시 공통 키로 조회.
//    3) 현재 상황 카드를 렌더하는 모든 페이지(info/competency/experience)가 "동일한" 공통 키를 요청.
//    4) 일반 모드 vs mode=test 가 동일한 Help DTO 구조(path-only) — content 동일.
//    5) org 없음/각 org 분기에서 동일 키·동일 구조.
//    6) Help API 가 페이지별·org별 키로 분기하지 않음(path-only 공통).
//    7) 주차 기본값 + 현재 상황 3값(오늘/개설 필요/개설 이행)이 normal==test 동일.
//   선행: dev server(:3000). 실행:
//    npx tsx --env-file=.env.local scripts/verify-lineopen-currentsituation-help.ts

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
function note(msg: string) { console.log(`   · ${msg}`); }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// 현재 상황 카드 공통 키(단일 공유 컴포넌트 PracticalInfoCurrentSituation).
const CS_TITLE_KEY = "admin.lineOpening.currentSituation.title.card";
const CS_KEYS = [
  CS_TITLE_KEY,
  "admin.lineOpening.currentSituation.info.today",
  "admin.lineOpening.currentSituation.info.needPeriod",
  "admin.lineOpening.currentSituation.info.fulfilPeriod",
] as const;
// 삭제된 CardDescription 문구/키.
const REMOVED_TEXT = "선택 주차의 실무 정보 라인 개설 상황";
const REMOVED_KEY = "admin.lineOpening.info.badge.openStatus";

async function adminEmail(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  if (error) throw error;
  const email = (data?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  return email;
}
async function makeSession(email: string) {
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email, token: link.properties.email_otp, type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token, refresh_token: verified.session.refresh_token,
  });
  return captured;
}
const baseHost = new URL(baseUrl).hostname;
const baseSecure = new URL(baseUrl).protocol === "https:";
function toPlaywrightCookies(captured: Array<{ name: string; value: string }>) {
  return captured.map(({ name, value }) => ({
    name, value, domain: baseHost, path: "/", httpOnly: false, secure: baseSecure, sameSite: "Lax" as const,
  }));
}
function toCookieHeader(captured: Array<{ name: string; value: string }>) {
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function discoverOrg(): Promise<string> {
  if (process.env.VERIFY_ORG) return process.env.VERIFY_ORG;
  const { data } = await supabaseAdmin
    .from("cluster4_team_halves").select("organization_slug").eq("is_active", true)
    .not("organization_slug", "is", null).limit(1);
  return (data?.[0] as { organization_slug: string } | undefined)?.organization_slug ?? "phalanx";
}

type HelpReq = { path: string | null; mode: string | null; org: string | null };
function wireHelpSniffer(page: Page, sink: HelpReq[]) {
  page.on("request", (request) => {
    const u = new URL(request.url());
    if (u.pathname !== "/api/admin/help") return;
    if (request.method() !== "GET") return;
    sink.push({ path: u.searchParams.get("path"), mode: u.searchParams.get("mode"), org: u.searchParams.get("org") });
  });
}

const HELP_BTN = "이 항목 도움말";

async function gotoStable(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/Unhandled Runtime Error|Build Error|Failed to compile|500 -/.test(bodyText)) {
    throw new Error(`page error at ${url}: ${bodyText.slice(0, 400)}`);
  }
}

// "현재 상황" CardTitle 내부의 도움말 버튼 클릭 → 조회 path 캡처.
async function clickCurrentSituationHelp(page: Page, sink: HelpReq[]): Promise<HelpReq | null> {
  const before = sink.length;
  const title = page.locator('[data-slot="card-title"]', { hasText: "현재 상황" }).first();
  if ((await title.count()) === 0) return null;
  const btn = title.getByRole("button", { name: HELP_BTN }).first();
  if ((await btn.count()) === 0) return null;
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape").catch(() => {});
  return sink.slice(before)[0] ?? null;
}

// "현재 상황" 카드의 3개 값(오늘/개설 필요/개설 이행) 텍스트 추출 — normal/test 비교용.
async function currentSituationValues(page: Page): Promise<string[]> {
  const card = page.locator('[data-slot="card"]', { hasText: "현재 상황" }).first();
  await card.waitFor({ timeout: 8000 }).catch(() => {});
  const values = card.locator(".font-semibold");
  // season-weeks 조회+계산 완료(값 span 렌더)까지 대기 — LoadingState 동안엔 값이 없다.
  await page.waitForFunction(
    () => {
      const c = Array.from(document.querySelectorAll('[data-slot="card"]'))
        .find((el) => el.textContent?.includes("현재 상황"));
      return !!c && c.querySelectorAll(".font-semibold").length >= 3;
    },
    { timeout: 8000 },
  ).catch(() => {});
  const vals = await values.allInnerTexts().catch(() => [] as string[]);
  return vals.map((v) => v.trim()).filter(Boolean);
}

async function main() {
  const email = await adminEmail();
  const captured = await makeSession(email);
  const cookieHeader = toCookieHeader(captured);
  const org = await discoverOrg();
  console.log(`base=${baseUrl}  admin=${email}  org=${org}\n`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addCookies(toPlaywrightCookies(captured));
  const page = await ctx.newPage();
  const sink: HelpReq[] = [];
  wireHelpSniffer(page, sink);

  const RT = {
    info: "/admin/line-opening/practical-info",
    competency: "/admin/line-opening/practical-competency",
    experience: "/admin/line-opening/practical-experience",
  };

  try {
    // ══ 1) CardDescription 삭제 확인(info · normal + test) ═══════════════════
    console.log("── 1) 상단 설명 문구/도움말 삭제 (info) ──");
    for (const [label, url] of [["normal", RT.info], ["test", `${RT.info}?mode=test`]] as const) {
      await gotoStable(page, `${baseUrl}${url}`);
      const body = await page.locator("body").innerText();
      const gone = !body.includes(REMOVED_TEXT);
      check(`[info:${label}] 설명 문구 "${REMOVED_TEXT}" 삭제됨`, gone);
      // "주차별 개설 결과" 카드 헤더엔 제목만 — 카드가 여전히 렌더되는지도 확인.
      const hasTitle = body.includes("주차별 개설 결과");
      check(`[info:${label}] "주차별 개설 결과" 제목은 유지`, hasTitle);
    }

    // ══ 2) 현재 상황 제목 도움말 버튼 + 클릭 → 공통 키(info) ══════════════════
    console.log("\n── 2) 현재 상황 제목 도움말 → 공통 키 (info) ──");
    await gotoStable(page, `${baseUrl}${RT.info}`);
    const infoReq = await clickCurrentSituationHelp(page, sink);
    check(`[info] 현재 상황 도움말 클릭 → ${CS_TITLE_KEY}`, infoReq?.path === CS_TITLE_KEY, infoReq);

    // ══ 3) 다른 페이지도 같은 공통 키 요청(competency/experience) ═════════════
    console.log("\n── 3) 타 페이지 동일 공통 키 (competency/experience) ──");
    // competency: 라인 관리 탭 상단 보드에서 현재 상황 렌더(?org 필요).
    await gotoStable(page, `${baseUrl}${RT.competency}?org=${org}`);
    const compReq = await clickCurrentSituationHelp(page, sink);
    if (compReq) check(`[competency] 현재 상황 도움말 → ${CS_TITLE_KEY}`, compReq.path === CS_TITLE_KEY, compReq);
    else note("[competency] 현재 상황 카드 미렌더(라인 관리 보드 데이터 게이팅) — API(D)로 공통성 확인.");
    // experience: 라인 개설 탭 상태창에서 현재 상황 렌더(?org&tab=open).
    await gotoStable(page, `${baseUrl}${RT.experience}?org=${org}&tab=open`);
    const expReq = await clickCurrentSituationHelp(page, sink);
    if (expReq) check(`[experience] 현재 상황 도움말 → ${CS_TITLE_KEY}`, expReq.path === CS_TITLE_KEY, expReq);
    else note("[experience] 현재 상황 카드 미렌더(상태창 데이터 게이팅) — API(D)로 공통성 확인.");

    const observed = [infoReq, compReq, expReq].filter(Boolean) as HelpReq[];
    const uniquePaths = new Set(observed.map((r) => r.path));
    check("현재 상황 도움말은 페이지 무관 단일 공통 키", uniquePaths.size === 1 && uniquePaths.has(CS_TITLE_KEY), [...uniquePaths]);
    // 요청 URL에 org/mode 로 키가 갈라지지 않음(키 문자열엔 org/mode 없음).
    const noBranch = observed.every((r) => r.path === CS_TITLE_KEY && !/(encre|oranke|phalanx|mode|test)/.test(r.path ?? ""));
    check("Help 요청 키가 page/org/mode 로 분기되지 않음", noBranch);

    // ══ 4·5·6) /api/admin/help path-only 공통 — 4키 × mode/org 변주 content 동일 ══
    console.log("\n── 4·5·6) /api/admin/help path-only 공통성 (CS 4키 × mode/org) ──");
    async function getHelp(path: string, qs: string) {
      const res = await fetch(`${baseUrl}/api/admin/help?path=${encodeURIComponent(path)}${qs}`, {
        headers: { cookie: cookieHeader }, cache: "no-store",
      } as RequestInit);
      const json: any = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body: json };
    }
    let neutralAll = true;
    for (const key of CS_KEYS) {
      const plain = await getHelp(key, "");
      const test = await getHelp(key, "&mode=test");
      const orgA = await getHelp(key, `&org=${org}`);
      const orgB = await getHelp(key, "&mode=test&org=oranke");
      const a = JSON.stringify(plain.body?.data?.content ?? null);
      const b = JSON.stringify(test.body?.data?.content ?? null);
      const c = JSON.stringify(orgA.body?.data?.content ?? null);
      const d = JSON.stringify(orgB.body?.data?.content ?? null);
      const ok = plain.ok && test.ok && orgA.ok && orgB.ok && a === b && b === c && c === d && plain.body?.success === true;
      if (!ok) neutralAll = false;
      note(`${key} :: plain=${plain.status} test=${test.status} org=${orgA.status} org2=${orgB.status} content동일=${a === b && b === c && c === d} len=${String(plain.body?.data?.content ?? "").length}`);
    }
    check("CS 4키: 도움말 본문이 mode/org 변주와 무관(path-only 공통)", neutralAll);

    // 삭제 키는 더 이상 런타임 요청되지 않음(sink 전체 확인).
    const removedRequested = sink.some((r) => r.path === REMOVED_KEY);
    check(`삭제 키 ${REMOVED_KEY} 는 런타임에서 요청되지 않음`, !removedRequested);

    // ══ 7) 주차 기본값 + 현재 상황 3값 normal==test 동일 ═════════════════════
    console.log("\n── 7) 현재 상황 3값 normal==test 동일 ──");
    await gotoStable(page, `${baseUrl}${RT.info}`);
    const valsNormal = await currentSituationValues(page);
    await gotoStable(page, `${baseUrl}${RT.info}?mode=test`);
    const valsTest = await currentSituationValues(page);
    check("현재 상황 3값(오늘/개설 필요/개설 이행) normal==test 동일",
      valsNormal.length >= 3 && JSON.stringify(valsNormal) === JSON.stringify(valsTest),
      { normal: valsNormal, test: valsTest });
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAIL`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
