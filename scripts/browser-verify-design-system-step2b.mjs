// 브라우저(인증 세션) 검증 — 디자인 시스템 확장 적용 Step 2-b
//   (/admin/integrated/line-opening/practical-info · 원본 경로 /admin/line-opening/practical-info).
//
// 적용 범위: [라인 관리] 탭의 "현재 상황" ↔ "주차별 개설 결과" 경계에만 wave-dot 1개.
//   [라인 개설] 탭(?tab=open)과 숨겨진 섹션(SHOW_MANAGE_LINE_SECTIONS=false)은 무접촉.
//
// 확인 항목:
//   · 제목 신규 추가 0 · 위치 이동 0 · CardTitle 이동 0 (h1 1개 + CardTitle 문구/순서 불변)
//   · wave-dot 1개 · 중복 구분선 0
//   · 세로 여백 = /admin/periods/register 기준과 동일 computed 값
//   · 숨겨진 탭 영향 0 (open 탭 wave-dot 0 · 기존 fade 1개 그대로 · CardTitle 3개 불변)
//   · 통합 경로 ≡ 원본 경로 (동일 컴포넌트 재수출) · mode=test · org 3종 구조 동일
//
// 사용법: node scripts/browser-verify-design-system-step2b.mjs
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
const admin = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"));

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
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

async function readPage(page) {
  return page.evaluate(() => {
    const root = document.querySelector("main") ?? document.body;
    // 통합 경로(/admin/integrated/*)는 layout 의 IntegratedAdminSection 이 조직 선택 탭
    //   (AdminOrganizationTabs · role=tablist 4버튼)을 페이지 본문 "밖에" 덧붙인다. 디자인 비교는
    //   페이지 본문만 봐야 하므로 data-integrated-scoped-content 가 있으면 그 안으로 스코프를 좁힌다
    //   (원본 경로에는 이 래퍼가 없어 main 전체가 곧 본문). 셸 탭 유무는 아래에서 별도 검증.
    const main = root.querySelector("[data-integrated-scoped-content]") ?? root;
    const txt = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const headings = Array.from(main.querySelectorAll("h1,h2,h3,h4")).map((h) => ({
      tag: h.tagName.toLowerCase(), text: txt(h),
      accent: !!h.querySelector("span.bg-primary"),
      fontSize: getComputedStyle(h).fontSize,
    }));
    const seps = Array.from(main.querySelectorAll('[data-slot="separator"]')).map((s) => {
      const box = s.parentElement;
      const section = box?.parentElement ?? null;
      const stack = section?.parentElement ?? null;
      const cs = (el) => (el ? getComputedStyle(el) : null);
      return {
        variant: s.getAttribute("data-variant") ?? "",
        boxMarginTop: cs(box)?.marginTop ?? null,
        boxMarginBottom: cs(box)?.marginBottom ?? null,
        sectionTag: section?.tagName.toLowerCase() ?? null,
        sectionMarginTop: cs(section)?.marginTop ?? null,
        stackRowGap: cs(stack)?.rowGap ?? null,
      };
    });
    const stack = main.querySelector('[class*="admin-section-stack"]');
    return {
      headings, seps,
      rootStackClass: stack && typeof stack.className === "string" ? stack.className : null,
      rootRowGap: stack ? getComputedStyle(stack).rowGap : null,
      cards: main.querySelectorAll('[data-slot="card"]').length,
      cardTitles: Array.from(main.querySelectorAll('[data-slot="card-title"]')).map((c) => txt(c)),
      tables: main.querySelectorAll("table").length,
      headerCells: main.querySelectorAll("thead th").length,
      tablists: main.querySelectorAll('[role="tablist"]').length,
      tabButtons: main.querySelectorAll('[role="tab"]').length,
      // 셸(통합 경로) 상태 — 페이지 본문과 분리해 관찰한다.
      shellOrgTabs: !!root.querySelector("[data-integrated-scoped-content], [data-integrated-empty-content]"),
      orgGateEmpty: !!root.querySelector("[data-integrated-empty-content]"),
      bodyMounted: main !== root || !!main.querySelector('[class*="admin-section-stack"]'),
    };
  });
}

const fingerprint = (r) =>
  JSON.stringify({
    headings: r.headings.map((h) => [h.tag, h.accent, h.fontSize]),
    cardTitles: r.cardTitles,
    seps: r.seps.map((s) => [s.variant, s.boxMarginTop, s.boxMarginBottom, s.sectionMarginTop, s.stackRowGap]),
    cards: r.cards, tables: r.tables, headerCells: r.headerCells,
    tablists: r.tablists, tabButtons: r.tabButtons,
    rootRowGap: r.rootRowGap,
  });

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 }); break; }
    catch (e) { if (attempt >= 12) throw e; await page.waitForTimeout(5000); }
  }
  return readPage(page);
};

const MANAGE = "/admin/integrated/line-opening/practical-info?org=encre";
const OPEN = "/admin/integrated/line-opening/practical-info?org=encre&tab=open";
let refSpacing = null;

try {
  console.log("\n[0] 기준 /admin/periods/register (여백 SoT)");
  {
    const r = await load("/admin/periods/register");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check("wave-dot 1개", r.seps.length === 1 && !!w);
    if (w) {
      refSpacing = w;
      console.log(`    rowGap=${w.stackRowGap} · section mt=${w.sectionMarginTop} · divider=${w.boxMarginTop}/${w.boxMarginBottom}`);
    }
  }

  // ── 1) [라인 관리] 탭 — 적용 대상 ──
  console.log(`\n[1] ${MANAGE} (라인 관리 탭)`);
  let manageFp = null;
  {
    const r = await load(MANAGE);
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check("페이지 제목 h1 1개 = '실무 정보'(신규 추가 0 · 이동 0)",
      r.headings.filter((h) => h.tag === "h1").length === 1 && r.headings[0]?.text === "실무 정보",
      r.headings.map((h) => `${h.tag}:${h.text}`).join(" | "));
    check("섹션 제목 신규 추가 0(h2~h4 0개)", r.headings.filter((h) => h.tag !== "h1").length === 0);
    check("CardTitle 2개 · 문구/순서 불변", r.cardTitles.length === 2
      && r.cardTitles[0] === "현재 상황" && r.cardTitles[1] === "주차별 개설 결과", r.cardTitles.join(" | "));
    check("wave-dot 1개(현재 상황 ↔ 주차별 개설 결과)", wave.length === 1);
    check("중복 구분선 0(보이는 의미적 구분선 총 1개)", r.seps.length === 1,
      `총 ${r.seps.length}: ${r.seps.map((s) => s.variant).join(",")}`);
    check("구분선이 section(PageSection) 안", wave[0]?.sectionTag === "section", wave[0]?.sectionTag ?? "-");
    check("루트 stack = admin-section-stack(-lg 아님)",
      /admin-section-stack(?!-lg)/.test(r.rootStackClass ?? "") && !/admin-section-stack-lg/.test(r.rootStackClass ?? ""),
      r.rootStackClass ?? "-");
    if (wave.length === 1 && refSpacing) {
      const w = wave[0];
      const same = w.boxMarginTop === refSpacing.boxMarginTop && w.boxMarginBottom === refSpacing.boxMarginBottom
        && w.sectionMarginTop === refSpacing.sectionMarginTop && w.stackRowGap === refSpacing.stackRowGap;
      check("세로 여백 = 기준 페이지와 동일", same,
        `rowGap=${w.stackRowGap} mt=${w.sectionMarginTop} divider=${w.boxMarginTop}/${w.boxMarginBottom}`);
      check("구분선 위·아래 대칭", w.boxMarginTop === w.boxMarginBottom, `${w.boxMarginTop} / ${w.boxMarginBottom}`);
    }
    manageFp = fingerprint(r);
  }

  // ── 2) [라인 개설] 탭 ──
  //   ※ Step 2-b 시점에는 미적용(기존 fade 유지)이었으나, Step 3-b(2026-07-27)에서 이 탭의
  //     업무 섹션 경계([상태창+로그창] ↔ [라인 개설])의 fade 를 wave-dot 으로 교체했다
  //     (공용 LineOpeningSectionDivider). 상세 검증은 step3b 스크립트가 담당하고,
  //     여기서는 "경계당 구분선 1개" 와 제목/CardTitle 불변만 확인한다.
  console.log(`\n[2] ${OPEN} (라인 개설 탭 · 경계 1곳 = step3b 적용분)`);
  let openFp = null;
  {
    const r = await load(OPEN);
    check("wave-dot 1개(step3b 적용)", r.seps.filter((s) => s.variant === "wave-dot").length === 1,
      r.seps.map((s) => s.variant).join(",") || "구분선 없음");
    check("기존 fade 잔존 0(교체 완료·중복 없음)",
      r.seps.filter((s) => s.variant === "fade").length === 0 && r.seps.length === 1,
      `fade=${r.seps.filter((s) => s.variant === "fade").length} 총=${r.seps.length}`);
    check("CardTitle 3개 불변(상태창/로그창/라인 개설)", r.cardTitles.length === 3
      && r.cardTitles[0] === "상태창" && r.cardTitles[1] === "로그창" && r.cardTitles[2] === "라인 개설",
      r.cardTitles.join(" | "));
    check("페이지 제목 h1 1개", r.headings.filter((h) => h.tag === "h1").length === 1);
    openFp = fingerprint(r);
  }

  // ── 3) 통합 경로 ≡ 원본 경로 (동일 컴포넌트 재수출) ──
  //   차이는 통합 경로 layout(IntegratedAdminSection)이 덧붙이는 조직 선택 탭 하나뿐 —
  //   페이지 본문(data-integrated-scoped-content 내부)은 완전히 동일해야 한다.
  console.log("\n[3] 통합 경로 ≡ 원본 경로 (본문 기준)");
  {
    const r = await load("/admin/line-opening/practical-info?org=encre");
    check("원본 /admin/line-opening/practical-info 본문 구조 동일", fingerprint(r) === manageFp);
    check("원본 경로에는 통합 셸 조직탭 없음(기존 구조)", !r.shellOrgTabs);
    const r2 = await load("/admin/line-opening/practical-info?org=encre&tab=open");
    check("원본 open 탭 본문 구조 동일", fingerprint(r2) === openFp);
  }

  // ── 4) mode=test ──
  console.log("\n[4] mode=test 구조 동일");
  {
    const r = await load(`${MANAGE}&mode=test`);
    check("라인 관리 탭: 일반 vs mode=test 동일", fingerprint(r) === manageFp);
    const r2 = await load(`${OPEN}&mode=test`);
    check("라인 개설 탭: 일반 vs mode=test 동일", fingerprint(r2) === openFp);
  }

  // ── 5) org 3종 ──
  console.log("\n[5] org 3종 (동일 컴포넌트)");
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await load(`/admin/integrated/line-opening/practical-info?org=${org}`);
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check(`org=${org}: wave-dot 1개 · 구분선 총 1개 · h1 1개 · h2~h4 0개`,
      wave.length === 1 && r.seps.length === 1
      && r.headings.filter((h) => h.tag === "h1").length === 1
      && r.headings.filter((h) => h.tag !== "h1").length === 0,
      `seps=${r.seps.map((s) => s.variant).join(",")} titles=${r.cardTitles.join("|")}`);
  }

  // ── 6) org 없는 통합 경로 — 기존 org 게이트(IntegratedAdminSection:26)로 본문 미마운트 ──
  //   Manager 자체가 렌더되지 않으므로 제목/구분선이 0인 것이 정상이며, 이 변경과 무관하다.
  console.log("\n[6] org 없는 통합 경로 (기존 org 게이트)");
  {
    const r = await load("/admin/integrated/line-opening/practical-info");
    check("org 미선택 → 본문 미마운트(기존 게이트 유지)", r.orgGateEmpty, "data-integrated-empty-content");
    check("본문 미마운트이므로 제목 0 · 구분선 0(누수 없음)",
      r.headings.length === 0 && r.seps.length === 0,
      `headings=${r.headings.length} seps=${r.seps.length}`);
  }

  // ── 6-b) org 없는 원본 경로 — 여기서는 Manager 가 렌더된다(px-4 py-6 분기) ──
  console.log("\n[6-b] org 없는 원본 경로 (Manager 렌더됨)");
  {
    const r = await load("/admin/line-opening/practical-info");
    check("h1 1개 유지", r.headings.filter((h) => h.tag === "h1").length === 1,
      r.headings.map((h) => `${h.tag}:${h.text}`).join(" | "));
    check("wave-dot 1개 · 중복 구분선 0",
      r.seps.filter((s) => s.variant === "wave-dot").length === 1 && r.seps.length === 1,
      r.seps.map((s) => s.variant).join(",") || "없음");
    check("루트 stack = admin-section-stack",
      /admin-section-stack(?!-lg)/.test(r.rootStackClass ?? "") && !/admin-section-stack-lg/.test(r.rootStackClass ?? ""),
      r.rootStackClass ?? "-");
  }

  // ── 7) 390px 반응형 ──
  console.log("\n[7] 390px 폭");
  await page.setViewportSize({ width: 390, height: 900 });
  {
    const ref = await load("/admin/periods/register");
    const r = await load(MANAGE);
    const rw = r.seps.find((s) => s.variant === "wave-dot");
    const fw = ref.seps.find((s) => s.variant === "wave-dot");
    check("모바일 여백도 기준 페이지와 동일",
      !!rw && !!fw && rw.stackRowGap === fw.stackRowGap && rw.sectionMarginTop === fw.sectionMarginTop
      && rw.boxMarginTop === fw.boxMarginTop && rw.boxMarginBottom === fw.boxMarginBottom,
      rw ? `rowGap=${rw.stackRowGap} mt=${rw.sectionMarginTop} divider=${rw.boxMarginTop}/${rw.boxMarginBottom}` : "없음");
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
