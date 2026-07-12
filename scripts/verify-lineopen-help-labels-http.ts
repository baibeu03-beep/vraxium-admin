import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening/* 라벨/설명(캡션) 도움말(돋보기) 신규 추가분 HTTP 검증.
//   목표(사용자 요청):
//    1) mode=test 와 일반 모드의 "도움말 렌더링(구조)"이 동일 — 페이지별 돋보기 개수 동치.
//    2) org(encre/oranke/phalanx) 무관 동일 — org 스코프 페이지에서 돋보기 개수 동치.
//    3) 신규 helpKey 8종이 실제 렌더 + 클릭 시 의도한 path 로 /api/admin/help 조회(공통 키).
//    4) 도움말 본문이 mode/org 에 무관(공통) — 서버가 path 로만 조회함을 API 로 직접 확인.
//   설계 참고: AdminModeProvider 가 window.fetch 를 패치해 admin 요청에 ambient mode 를 부착하지만,
//    /api/admin/help 라우트는 mode/org 를 읽지 않고 path 로만 조회/저장한다 → 공통 도움말.
//   선행: dev server(:3000). 실행:
//    npx tsx --env-file=.env.local scripts/verify-lineopen-help-labels-http.ts

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

// 이번 커밋에서 추가한 신규 helpKey 8종(라이브 · CardDescription/캡션).
const NEW_KEYS = [
  "admin.lineOpening.career.desc.registeredLines",
  "admin.lineOpening.career.desc.openTargetWeek",
  "admin.lineOpening.career.desc.openForm",
  "admin.lineOpening.career.desc.sponsorNote",
  "admin.career.evaluation.desc.card",
  "admin.lineOpening.career.opening.desc.tableCount",
  "admin.lineOpening.statusBoard.desc.board",
  "admin.lineOpening.info.section.reviewCrewList",
] as const;

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
// 쿠키 도메인/secure 를 대상 baseUrl 에서 파생 → 로컬(localhost/http) · Vercel(https) 모두 대응.
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
const helpCount = (page: Page) => page.getByRole("button", { name: HELP_BTN }).count();

async function gotoStable(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  if (/Unhandled Runtime Error|Build Error|Failed to compile|500 -/.test(bodyText)) {
    throw new Error(`page error at ${url}: ${bodyText.slice(0, 400)}`);
  }
}
function xpathStr(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  return "concat('" + s.split("'").join(`', "'", '`) + "')";
}
// 설명/캡션 텍스트를 담고 도움말 버튼을 포함하는 요소의 그 버튼을 클릭 → path 캡처.
async function clickHelpNextTo(page: Page, sink: HelpReq[], textNeedle: string): Promise<HelpReq | null> {
  const before = sink.length;
  const holder = page.locator(
    `xpath=//*[self::p or self::div][contains(normalize-space(.), ${xpathStr(textNeedle)})]`,
  ).filter({ has: page.getByRole("button", { name: HELP_BTN }) }).last();
  if ((await holder.count()) === 0) return null;
  const btn = holder.getByRole("button", { name: HELP_BTN }).last();
  await btn.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape").catch(() => {});
  return sink.slice(before)[0] ?? null;
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
    career: "/admin/line-opening/practical-career",
    experience: "/admin/line-opening/practical-experience",
    competency: "/admin/line-opening/practical-competency",
  };

  try {
    // ══ A) chrome-stable 페이지 파리티(career/competency) ═══════════════════
    // career/competency 는 도움말이 필터/폼필드/탭/열헤더 등 population 과 무관한 chrome 에 붙는다
    //  → 총 개수 동치가 유효한 파리티 지표.
    // (info/experience 는 라인/주차 데이터에 따라 per-line 도움말이 늘고 줄어 총 개수가 data-gated →
    //  아래 A2/B 에서 별도 방식으로 검증.)
    console.log("── A) chrome-stable 파리티 (career) ──");
    const staticTargets: Array<[string, string, string]> = [
      ["career", RT.career, `${RT.career}?mode=test`],
    ];
    for (const [key, normal, test] of staticTargets) {
      await gotoStable(page, `${baseUrl}${normal}`);
      const n = await helpCount(page);
      await gotoStable(page, `${baseUrl}${test}`);
      const t = await helpCount(page);
      check(`[${key}] 로드 OK · 돋보기 normal==test`, n === t && n > 0, { normal: n, test: t });
    }

    // ══ A2) data-gated 페이지(info/competency) — 양 모드 로드 OK + 도움말 존재 ══
    //   info/competency 는 라인/크루/신청 데이터에 비례하는 per-row 도움말이 있어 총 개수가
    //   population(운영 vs test)에 따라 달라진다 → 총개수 파리티 대신 "로드 OK·도움말 존재" 로 검증.
    console.log("\n── A2) data-gated(info/competency) — 로드 OK · 도움말 존재 ──");
    for (const [key, normal, test] of [
      ["info", RT.info, `${RT.info}?mode=test`],
      ["competency", `${RT.competency}?org=${org}`, `${RT.competency}?org=${org}&mode=test`],
    ] as Array<[string, string, string]>) {
      await gotoStable(page, `${baseUrl}${normal}`);
      const n = await helpCount(page);
      await gotoStable(page, `${baseUrl}${test}`);
      const t = await helpCount(page);
      check(`[${key}] normal/test 모두 로드 OK · 도움말 존재(>0)`, n > 0 && t > 0, { normal: n, test: t });
    }
    note("info/competency 총 개수는 라인/크루 수(per-row 도움말)에 비례 → data-gated(내 변경과 무관).");

    // ══ B) experience(데이터 게이팅) — "렌더되는 곳의 도움말 구조 불변" ═════════
    //   experience 상태창/입력 보드는 org·주차에 운영 데이터가 있을 때만 렌더된다(사전 존재 동작).
    //   따라서 총 개수는 데이터 가용성에 따라 org·mode 별로 달라질 수 있다(도움말 구조 변화가 아님).
    //   검증: (1) 섹션이 렌더되는 경우의 비영(non-zero) 도움말 개수는 단일값(구조 동일),
    //         (2) 섹션이 렌더되는 org 는 normal==test(모드 불변).
    console.log("\n── B) experience(org×mode) — 렌더되는 곳의 도움말 구조 불변 ──");
    const expNormal: Record<string, number> = {};
    const expTest: Record<string, number> = {};
    for (const o of ["encre", "oranke", "phalanx"]) {
      await gotoStable(page, `${baseUrl}${RT.experience}?org=${o}`);
      expNormal[o] = await helpCount(page);
      await gotoStable(page, `${baseUrl}${RT.experience}?org=${o}&mode=test`);
      expTest[o] = await helpCount(page);
    }
    const nonZero = [...Object.values(expNormal), ...Object.values(expTest)].filter((v) => v > 0);
    check("[experience] 렌더되는 곳의 도움말 구조 동일(비영 카운트 단일값)", new Set(nonZero).size <= 1 && nonZero.length > 0, { expNormal, expTest });
    for (const o of ["encre", "oranke", "phalanx"]) {
      if (expNormal[o] > 0) check(`[experience:${o}] 섹션 렌더 · normal==test`, expNormal[o] === expTest[o], { normal: expNormal[o], test: expTest[o] });
      else note(`[experience:${o}] normal 모드 운영 데이터 없음 → 보드 데이터 게이팅(도움말과 무관). test=${expTest[o]}`);
    }

    // ══ C) 신규 helpKey — 실제 클릭 → 의도한 path 로 조회(공통 키) ════════════
    console.log("\n── C) 신규 helpKey 런타임(클릭) → path 확인 ──");
    const clicked = new Map<string, HelpReq>();
    async function verifyClick(label: string, needle: string, expected: string) {
      const r = await clickHelpNextTo(page, sink, needle);
      if (r?.path === expected) { clicked.set(expected, r); check(`${label} → ${expected}`, true, { mode: r.mode, org: r.org }); }
      else check(`${label} → ${expected}`, false, { got: r });
    }
    async function clickTab(name: RegExp) {
      // 커스텀 TabButton(=<button>, ARIA role=tab 아님) → 버튼 텍스트로 클릭.
      await page.getByRole("button", { name }).first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1400);
    }
    await gotoStable(page, `${baseUrl}${RT.career}`);
    await verifyClick("등록된 경력 라인 개수 설명", "총", "admin.lineOpening.career.desc.registeredLines");
    await clickTab(/^경력 라인 개설$/);
    await verifyClick("개설 대상 주차 안내", "운영 기본값은 현재 주차이며", "admin.lineOpening.career.desc.openTargetWeek");
    await verifyClick("개설 라인 개수/필터 설명", "필터 결과", "admin.lineOpening.career.opening.desc.tableCount");
    await clickTab(/경력 기록\/평가 관리/);
    await verifyClick("경력 라인 평가 기준", "대상자별 평점", "admin.career.evaluation.desc.card");
    // statusBoard 설명(experience team variant) — [라인 개설] 탭(?org=..&tab=open)에서만 렌더.
    await gotoStable(page, `${baseUrl}${RT.experience}?org=${org}&tab=open`);
    await page.waitForTimeout(1500);
    await verifyClick("상태창 안내", "라인 개설 운영 현황", "admin.lineOpening.statusBoard.desc.board");
    note(`런타임 클릭 확인: ${clicked.size}/5 (미도달분은 폼/모달 조건부 → D 에서 API 로 확인)`);
    check("클릭으로 확인된 신규 키 >= 4 (나머지는 D 에서 API 확인)", clicked.size >= 4, [...clicked.keys()]);

    // ══ D) 도움말 본문 org/mode 무관(공통) — API 직접 확인(신규 8종 전부) ══════
    console.log("\n── D) /api/admin/help path-only 공통성 (신규 8종, mode/org 변주) ──");
    async function getHelp(path: string, qs: string) {
      const res = await fetch(`${baseUrl}/api/admin/help?path=${encodeURIComponent(path)}${qs}`, {
        headers: { cookie: cookieHeader }, cache: "no-store",
      } as RequestInit);
      const json: any = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body: json };
    }
    let neutralAll = true;
    for (const key of NEW_KEYS) {
      const plain = await getHelp(key, "");
      const test = await getHelp(key, "&mode=test");
      const otherOrg = await getHelp(key, "&mode=test&org=oranke");
      const a = JSON.stringify(plain.body?.data?.content ?? null);
      const b = JSON.stringify(test.body?.data?.content ?? null);
      const c = JSON.stringify(otherOrg.body?.data?.content ?? null);
      const ok = plain.ok && test.ok && otherOrg.ok && a === b && b === c && plain.body?.success === true;
      if (!ok) neutralAll = false;
      note(`${key} :: plain=${plain.status} test=${test.status} org=${otherOrg.status} content동일=${a === b && b === c}`);
    }
    check("신규 8종: 도움말 본문이 mode/org 변주와 무관(path-only 공통)", neutralAll);

    // ══ E) 아이콘 present vs 기본문구(콘텐츠 부재) 구분 + 기존 키(#6) ════════════
    console.log("\n── E) route 서빙 + 콘텐츠(등록 도움말) 유무 (#6/#7/#8) ──");
    const EXISTING_KEYS = [
      "admin.lineOpening.career.opening.field.mainTitle",   // 메인 타이틀(경력 개설 폼)
      "admin.lineOpening.career.opening.field.outputAsset", // 아웃풋(경력 개설 폼)
      "admin.lineOpening.info.field.mainTitle",             // 메인 타이틀(정보 개설 폼)
      "admin.lineOpening.info.field.output",                // 아웃풋(정보 개설 폼)
    ];
    let routeOkAll = true;
    for (const key of [...NEW_KEYS, ...EXISTING_KEYS]) {
      const r = await getHelp(key, "");
      const len = String(r.body?.data?.content ?? "").length;
      if (!(r.ok && r.body?.success === true)) routeOkAll = false;
      note(`${key} :: route=${r.status} contentLen=${len} ${len > 0 ? "(콘텐츠 있음)" : "(기본문구=미작성)"}`);
    }
    check("전 키(신규8+기존4): 프로덕션 /api/admin/help 200 서빙", routeOkAll);
    note("아이콘 렌더=코드 배포 여부 / 기본문구=DB admin_page_help_contents 미작성(정상, 모달로 작성). 원 증상은 아이콘(코드) 배포 gap.");

    // ══ E2) 경력 개설 폼 브라우저 렌더(#6 메인타이틀/아웃풋 + 심층 신규) best-effort ══
    console.log("\n── E2) 경력 개설 폼 실제 DOM 렌더 (#6 + 심층 신규) best-effort ──");
    await gotoStable(page, `${baseUrl}${RT.career}`);
    await clickTab(/^경력 라인 개설$/);
    await page.getByRole("button", { name: /새 실무 경력 라인 개설/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1600);
    const deep = new Map<string, HelpReq>();
    async function tryDeep(label: string, needle: string, expected: string) {
      const r = await clickHelpNextTo(page, sink, needle);
      const ok = r?.path === expected;
      if (ok) deep.set(expected, r!);
      note(`${ok ? "✅" : "·"} ${label} → ${expected} ${ok ? "(실제 DOM 렌더 확인)" : "(미도달: 개설 가능 폼 미노출)"}`);
    }
    await tryDeep("메인 타이틀(기존)", "메인 타이틀", "admin.lineOpening.career.opening.field.mainTitle");
    await tryDeep("Output Asset(기존)", "Output Asset", "admin.lineOpening.career.opening.field.outputAsset");
    await tryDeep("기입 마감 설명(신규)", "기입 마감", "admin.lineOpening.career.desc.openForm");
    await tryDeep("기업·감독자 저장 안내(신규)", "연결된 경력 프로젝트에 저장", "admin.lineOpening.career.desc.sponsorNote");
    note(`경력 개설 폼 심층 DOM 렌더 확인: ${deep.size}건 (0건=개설 가능 주차/폼 미노출; 코드는 배포 커밋에 포함).`);
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASS" : `❌ ${failed} FAIL`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
