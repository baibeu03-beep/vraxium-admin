// 브라우저(인증 세션) 검증 — 관리자 페이지 디자인 시스템 확장 적용 Step 1.
//   기준 페이지 /admin/periods/register 의 4가지(페이지 제목 위계 · 섹션 h2 액센트 ·
//   큰 섹션 간 wave-dot 구분 · 충분한 세로 여백)가 Step 1 대상 2개 페이지에 동일하게
//   적용됐는지, 그리고 기존 정보 구조(제목 개수/위치·카드·표)가 불변인지 확인한다.
//
// 확인 항목(요청 검증 목록과 1:1):
//   · 페이지 제목(h1) 개수 · 중복 섹션 제목 0 · 새로 추가된 제목 0(적용 전 개수와 동일)
//   · wave-dot 경계 개수 · 구분선 중복 0(경계당 보이는 구분선 1개)
//   · 공통 세로 여백 = 기준 페이지와 동일한 computed 값(rowGap/상쇄/구분선 위·아래)
//   · 카드·표 내부 변화 없음(카드/표/행 개수 fingerprint)
//   · 일반 vs mode=test DOM 구조 동일 · org 3종 동일 컴포넌트
//
// 사용법: node scripts/browser-verify-design-system-step1.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// 본문(main) 안의 제목 위계 · 구분선 · 세로 여백 · 카드/표 fingerprint 를 한 번에 읽는다.
//   글로벌 셸(사이드바·상단 breadcrumb)은 제외 — main 스코프로 한정해 페이지 본문만 본다.
async function readPage(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const txt = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

    const headings = Array.from(main.querySelectorAll("h1,h2,h3,h4")).map((h) => ({
      tag: h.tagName.toLowerCase(),
      text: txt(h),
      // 섹션 h2 좌측 액센트 바(span.bg-primary) 유무 — 섹션 위계 표식.
      accent: !!h.querySelector("span.bg-primary"),
      fontSize: getComputedStyle(h).fontSize,
      fontWeight: getComputedStyle(h).fontWeight,
    }));

    // 보이는 의미적 구분선(공통 Separator). 구조적 border-t/b(표·카드·입력)는 여기 안 잡힌다.
    const seps = Array.from(main.querySelectorAll('[data-slot="separator"]')).map((s) => {
      const box = s.parentElement; // PageSection 이 만든 mt/mb 블록
      const section = box?.parentElement ?? null;
      const stack = section?.parentElement ?? null;
      const cs = (el) => (el ? getComputedStyle(el) : null);
      return {
        variant: s.getAttribute("data-variant") ?? "",
        hidden: s.getAttribute("aria-hidden") === "true" || s.hasAttribute("aria-hidden"),
        boxMarginTop: cs(box)?.marginTop ?? null,
        boxMarginBottom: cs(box)?.marginBottom ?? null,
        sectionTag: section?.tagName.toLowerCase() ?? null,
        sectionMarginTop: cs(section)?.marginTop ?? null,
        stackRowGap: cs(stack)?.rowGap ?? null,
      };
    });

    // 카드·표 fingerprint(내부 구조 불변 확인용).
    const cards = main.querySelectorAll('[data-slot="card"]').length;
    const cardTitles = Array.from(main.querySelectorAll('[data-slot="card-title"]')).map((c) => txt(c));
    const tables = main.querySelectorAll("table").length;
    const headerCells = main.querySelectorAll("thead th").length;
    const bodyRows = main.querySelectorAll("tbody tr").length;

    return { headings, seps, cards, cardTitles, tables, headerCells, bodyRows };
  });
}

// 일반 vs mode=test / org 간 "렌더 구조" 비교용 지문 — 데이터 값(행 수·라벨)은 제외하고
//   제목 위계·구분선·카드/표 골격만 남긴다.
const structureFingerprint = (r) =>
  JSON.stringify({
    headings: r.headings.map((h) => [h.tag, h.accent, h.fontSize, h.fontWeight]),
    seps: r.seps.map((s) => [s.variant, s.boxMarginTop, s.boxMarginBottom, s.sectionMarginTop, s.stackRowGap]),
    cards: r.cards,
    tables: r.tables,
    headerCells: r.headerCells,
  });

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// dev 서버가 재컴파일/재시작 중이면 일시적으로 연결이 끊길 수 있어 한 번 재시도한다.
const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 });
      break;
    } catch (e) {
      if (attempt >= 12) throw e;
      await page.waitForTimeout(5000);
    }
  }
  return readPage(page);
};

// 기준 페이지에서 읽은 공통 여백 값 — 다른 페이지가 "같은 SoT" 를 쓰는지 비교하는 기준.
let refSpacing = null;

try {
  // ── 0) 기준 페이지 /admin/periods/register (SoT · 회귀 가드) ──
  console.log("\n[0] 기준 /admin/periods/register");
  {
    const r = await load("/admin/periods/register");
    const h1 = r.headings.filter((h) => h.tag === "h1");
    const h2 = r.headings.filter((h) => h.tag === "h2");
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check("페이지 제목(h1) 1개", h1.length === 1, h1.map((h) => h.text).join(" | "));
    check("섹션 h2 2개 + 액센트 바", h2.length === 2 && h2.every((h) => h.accent), h2.map((h) => `${h.text}(${h.fontSize})`).join(" | "));
    check("wave-dot 1곳", wave.length === 1);
    check("구분선 중복 없음(보이는 구분선 = wave-dot 1개)", r.seps.length === 1, `총 ${r.seps.length}개: ${r.seps.map((s) => s.variant).join(",")}`);
    if (wave.length === 1) {
      const w = wave[0];
      refSpacing = {
        boxMarginTop: w.boxMarginTop, boxMarginBottom: w.boxMarginBottom,
        sectionMarginTop: w.sectionMarginTop, stackRowGap: w.stackRowGap,
      };
      check("구분선 위·아래 여백 대칭", w.boxMarginTop === w.boxMarginBottom, `${w.boxMarginTop} / ${w.boxMarginBottom}`);
      console.log(`    기준 여백 SoT: rowGap=${w.stackRowGap} · section mt=${w.sectionMarginTop} · divider mt/mb=${w.boxMarginTop}`);
    }
  }

  // ── 1) /admin/rest-management (Step 1-a) ──
  console.log("\n[1] /admin/rest-management?org=encre");
  let restFp = null;
  {
    const r = await load("/admin/rest-management?org=encre");
    const h1 = r.headings.filter((h) => h.tag === "h1");
    const h2 = r.headings.filter((h) => h.tag === "h2");
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check("페이지 제목(h1) 1개 = '휴식 관리'", h1.length === 1 && h1[0].text === "휴식 관리", h1.map((h) => h.text).join(" | "));
    check("섹션 제목 신규 추가 0개(h2/h3/h4 없음)", h2.length === 0 && r.headings.length === 1, r.headings.map((h) => `${h.tag}:${h.text}`).join(" | "));
    check("CardTitle 0개(위치 이동/승격 없음)", r.cardTitles.length === 0, r.cardTitles.join(" | "));
    check("wave-dot 1곳(요약 ↔ 신청 목록)", wave.length === 1);
    check("구분선 중복 0건", r.seps.length === 1, `총 ${r.seps.length}개`);
    // 카드·표 내부 불변 핀 — 요약 Card 1 + StatCard 4 + 목록 Card 1 = 6, 표 1개(10열).
    check("카드 6개 · 표 1개(10열) 유지", r.cards === 6 && r.tables === 1 && r.headerCells === 10,
      `cards=${r.cards} tables=${r.tables} th=${r.headerCells} rows=${r.bodyRows}`);
    if (wave.length === 1 && refSpacing) {
      const w = wave[0];
      const same =
        w.boxMarginTop === refSpacing.boxMarginTop &&
        w.boxMarginBottom === refSpacing.boxMarginBottom &&
        w.sectionMarginTop === refSpacing.sectionMarginTop &&
        w.stackRowGap === refSpacing.stackRowGap;
      check("공통 세로 여백 = 기준 페이지와 동일", same,
        `rowGap=${w.stackRowGap} mt=${w.sectionMarginTop} divider=${w.boxMarginTop}/${w.boxMarginBottom}`);
    }
    restFp = structureFingerprint(r);
  }

  // ── 2) mode=test DOM 구조 동일 ──
  console.log("\n[2] /admin/rest-management?org=encre&mode=test (구조 동일)");
  {
    const r = await load("/admin/rest-management?org=encre&mode=test");
    check("일반 vs mode=test 렌더 구조 동일", structureFingerprint(r) === restFp);
    check("wave-dot 1곳(mode=test)", r.seps.filter((s) => s.variant === "wave-dot").length === 1);
  }

  // ── 3) org 3종 동일 컴포넌트 ──
  console.log("\n[3] /admin/rest-management org 3종 (동일 컴포넌트)");
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await load(`/admin/rest-management?org=${org}`);
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check(`org=${org}: h1 1개 · wave-dot 1곳 · h2 0개`,
      r.headings.filter((h) => h.tag === "h1").length === 1 && wave.length === 1 && r.headings.filter((h) => h.tag === "h2").length === 0);
  }

  // ── 4) /admin/processes/register (Step 1-b) ──
  console.log("\n[4] /admin/processes/register");
  let procFp = null;
  {
    const r = await load("/admin/processes/register");
    const h1 = r.headings.filter((h) => h.tag === "h1");
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check("페이지 제목 신규 추가 0개(h1 없음 = 적용 전과 동일)", h1.length === 0, h1.map((h) => h.text).join(" | "));
    check("섹션 제목 신규 추가 0개", r.headings.length === 0, r.headings.map((h) => `${h.tag}:${h.text}`).join(" | "));
    check("CardTitle '프로세스 등록' 카드 내부 유지", r.cardTitles.includes("프로세스 등록"), r.cardTitles.join(" | "));
    check("wave-dot 1곳(등록 폼 ↔ 조회 영역)", wave.length === 1);
    check("구분선 중복 0건", r.seps.length === 1, `총 ${r.seps.length}개`);
    check("카드·표 골격 유지(등록 폼 + 통합 목록)", r.cards >= 2 && r.tables === 1,
      `cards=${r.cards} tables=${r.tables} th=${r.headerCells}`);
    if (wave.length === 1 && refSpacing) {
      const w = wave[0];
      const same =
        w.boxMarginTop === refSpacing.boxMarginTop &&
        w.boxMarginBottom === refSpacing.boxMarginBottom &&
        w.sectionMarginTop === refSpacing.sectionMarginTop &&
        w.stackRowGap === refSpacing.stackRowGap;
      check("공통 세로 여백 = 기준 페이지와 동일", same,
        `rowGap=${w.stackRowGap} mt=${w.sectionMarginTop} divider=${w.boxMarginTop}/${w.boxMarginBottom}`);
    }
    procFp = structureFingerprint(r);
  }

  // ── 5) processes/register mode=test / org ──
  console.log("\n[5] /admin/processes/register mode=test · org");
  {
    const r1 = await load("/admin/processes/register?mode=test");
    check("일반 vs mode=test 렌더 구조 동일", structureFingerprint(r1) === procFp);
    const r2 = await load("/admin/processes/register?org=oranke");
    check("org=oranke 렌더 구조 동일", structureFingerprint(r2) === procFp);
  }

  // ── 6) 모바일 폭에서도 대칭 여백 유지 ──
  console.log("\n[6] 390px 폭 (반응형 여백)");
  await page.setViewportSize({ width: 390, height: 900 });
  for (const url of ["/admin/periods/register", "/admin/rest-management?org=encre", "/admin/processes/register"]) {
    const r = await load(url);
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check(`${url}: 구분선 위·아래 대칭`, !!w && w.boxMarginTop === w.boxMarginBottom,
      w ? `rowGap=${w.stackRowGap} mt=${w.sectionMarginTop} divider=${w.boxMarginTop}/${w.boxMarginBottom}` : "wave-dot 없음");
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
