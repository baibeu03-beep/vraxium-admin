// 브라우저(인증 세션) 검증 — 디자인 시스템 확장 적용 Step 3 (프로세스 체크 화면).
//   ProcessCheckManager 의 [액트 관리](섹션.0) ↔ [액트 체크](섹션.1) 경계에 wave-dot 1개.
//
//   ⚠ ProcessCheckManager 는 4개 허브(club/info/experience/competency)가 공유하는 단일
//     컴포넌트다 → club 뿐 아니라 4허브 전부에 같은 경계가 적용된다(허브별 디자인 분기 없음).
//     4허브 × 통합/원본 경로 모두 검증한다.
//
// 확인 항목:
//   · h1 1개 · h2 2개([액트 관리]·[액트 체크]) 유지 — 문구·개수·위치·크기 불변
//   · h2 는 공통 SectionHeading 규격(text-base=23.5px 계열 · font-semibold · 액센트 바) 유지
//     (/admin/periods/register 의 raw text-lg 와 통일하지 않음 — 이번 단계에서 의도적 보류)
//   · wave-dot 1개 · 중복 구분선 0 · 구분선은 [액트 체크] h2 "위"
//   · CardTitle 이동 0(상태창 1 / 로그창 / 상태창 2 위치·문구 불변)
//   · 세로 여백 = 기준 페이지와 동일 · 제목↔본문 간격 불변
//   · mode=test · org 3종 · 통합/원본 경로 구조 동일
//
// 사용법: node scripts/browser-verify-design-system-step3.mjs
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
    const main = root.querySelector("[data-integrated-scoped-content]") ?? root;
    const txt = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
    const headings = Array.from(main.querySelectorAll("h1,h2,h3,h4")).map((h) => ({
      tag: h.tagName.toLowerCase(), text: txt(h),
      accent: !!h.querySelector("span.bg-primary"),
      fontSize: getComputedStyle(h).fontSize,
      fontWeight: getComputedStyle(h).fontWeight,
    }));
    const seps = Array.from(main.querySelectorAll('[data-slot="separator"]')).map((s) => {
      const box = s.parentElement;
      const section = box?.parentElement ?? null;
      const parent = section?.parentElement ?? null;
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const prev = section?.previousElementSibling ?? null;
      // 구분선 "다음"에 오는 제목 — 경계가 [액트 체크] 위에 놓였는지 확인.
      const nextHeading = section?.querySelector("h2");
      return {
        variant: s.getAttribute("data-variant") ?? "",
        sectionTag: section?.tagName.toLowerCase() ?? null,
        sectionMarginTop: cs(section)?.marginTop ?? null,
        dividerMarginTop: cs(box)?.marginTop ?? null,
        dividerMarginBottom: cs(box)?.marginBottom ?? null,
        parentRowGap: cs(parent)?.rowGap ?? null,
        visibleGapAbove: prev ? Math.round(s.getBoundingClientRect().top - prev.getBoundingClientRect().bottom) : null,
        headingBelow: nextHeading ? txt(nextHeading) : null,
        prevText: prev ? txt(prev).slice(0, 28) : null,
      };
    });
    return {
      headings, seps,
      cardTitles: Array.from(main.querySelectorAll('[data-slot="card-title"]')).map(txt),
      cards: main.querySelectorAll('[data-slot="card"]').length,
      tables: main.querySelectorAll("table").length,
      headerCells: main.querySelectorAll("thead th").length,
    };
  });
}

const fingerprint = (r) =>
  JSON.stringify({
    headings: r.headings.map((h) => [h.tag, h.text, h.accent, h.fontSize, h.fontWeight]),
    cardTitles: r.cardTitles,
    seps: r.seps.map((s) => [s.variant, s.sectionMarginTop, s.dividerMarginTop, s.dividerMarginBottom, s.parentRowGap, s.headingBelow]),
    cards: r.cards, tables: r.tables, headerCells: r.headerCells,
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

// 부모 admin-section-stack(32/40) 기준 기대 여백.
const EXPECT_DESKTOP = { parentRowGap: "40px", sectionMarginTop: "-40px", divider: "56px", visibleGapAbove: 56 };
const EXPECT_MOBILE = { parentRowGap: "32px", sectionMarginTop: "-32px", divider: "48px", visibleGapAbove: 48 };
const assertSpacing = (label, sep, exp) => {
  const ok = sep && sep.parentRowGap === exp.parentRowGap && sep.sectionMarginTop === exp.sectionMarginTop
    && sep.dividerMarginTop === exp.divider && sep.dividerMarginBottom === exp.divider
    && sep.visibleGapAbove === exp.visibleGapAbove;
  check(label, ok, sep
    ? `gap=${sep.parentRowGap} mt=${sep.sectionMarginTop} divider=${sep.dividerMarginTop}/${sep.dividerMarginBottom} 가시=${sep.visibleGapAbove}px`
    : "wave-dot 없음");
};

const CLUB = "/admin/integrated/processes/check/club?org=encre";
// ProcessCheckManager 를 공유하는 4허브 — club 외 3허브도 같은 경계가 적용되는지 확인.
const HUBS = [["club", "클럽 총괄 급"], ["info", "실무 정보 급"], ["experience", "실무 경험 급"], ["competency", "실무 역량 급"]];

try {
  // ── 1) 대상 페이지 /admin/integrated/processes/check/club ──
  console.log(`\n[1] ${CLUB}`);
  let clubFp = null;
  {
    const r = await load(CLUB);
    const h1 = r.headings.filter((h) => h.tag === "h1");
    const h2 = r.headings.filter((h) => h.tag === "h2");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check("h1 1개 = '클럽 총괄 급'", h1.length === 1 && h1[0].text === "클럽 총괄 급", h1.map((h) => h.text).join(" | "));
    check("h2 2개 = [액트 관리]·[액트 체크](문구·개수·순서 불변)",
      h2.length === 2 && h2[0].text === "[액트 관리]" && h2[1].text === "[액트 체크]",
      h2.map((h) => h.text).join(" | "));
    check("h2 크기·굵기·액센트 바 불변(SectionHeading 규격 유지)",
      h2.every((h) => h.accent && h.fontWeight === "600") && h2[0].fontSize === h2[1].fontSize,
      h2.map((h) => `${h.fontSize}/${h.fontWeight}/bar=${h.accent}`).join(" | "));
    check("기준 페이지 raw text-lg 와 통일하지 않음(text-base 계열 유지)",
      parseFloat(h2[0]?.fontSize ?? "0") < parseFloat(h1[0]?.fontSize ?? "99"),
      `h2=${h2[0]?.fontSize} < h1=${h1[0]?.fontSize}`);
    check("wave-dot 1개 · 중복 구분선 0", r.seps.length === 1 && !!w,
      `총 ${r.seps.length}: ${r.seps.map((s) => s.variant).join(",") || "없음"}`);
    check("구분선이 [액트 체크] h2 '위'에 위치", w?.headingBelow === "[액트 체크]", w?.headingBelow ?? "-");
    check("구분선 직전 형제 = 상태창 2(섹션.0 끝)", /상태창 2/.test(w?.prevText ?? ""), w?.prevText ?? "-");
    check("CardTitle 3개 문구·순서 불변(이동 0)",
      r.cardTitles.length === 3 && r.cardTitles[0] === "상태창 1" && r.cardTitles[1] === "로그창"
      && r.cardTitles[2] === "상태창 2 · 이번 주 체크 진행 현황", r.cardTitles.join(" | "));
    check("표 1개 유지(카드·표 내부 불변)", r.tables === 1, `tables=${r.tables} th=${r.headerCells} cards=${r.cards}`);
    assertSpacing("세로 여백 = 기준 페이지와 동일", w, EXPECT_DESKTOP);
    clubFp = fingerprint(r);
  }

  // ── 2) mode=test ──
  console.log("\n[2] mode=test");
  {
    const r = await load(`${CLUB}&mode=test`);
    check("일반 vs mode=test 렌더 구조 동일", fingerprint(r) === clubFp);
  }

  // ── 3) 통합 경로 ≡ 원본 경로 ──
  console.log("\n[3] 통합 경로 ≡ 원본 경로 (본문 기준)");
  {
    const r = await load("/admin/processes/check/club?org=encre");
    check("원본 /admin/processes/check/club 본문 구조 동일", fingerprint(r) === clubFp);
  }

  // ── 4) org 3종 ──
  console.log("\n[4] org 3종 (동일 컴포넌트)");
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await load(`/admin/integrated/processes/check/club?org=${org}`);
    const h2 = r.headings.filter((h) => h.tag === "h2");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check(`org=${org}: h2 2개 · wave-dot 1개 · 중복 0 · [액트 체크] 위`,
      h2.length === 2 && r.seps.length === 1 && w?.headingBelow === "[액트 체크]",
      `h2=${h2.map((h) => h.text).join(",")} seps=${r.seps.map((s) => s.variant).join(",")}`);
  }

  // ── 5) 공유 컴포넌트 — 나머지 3허브도 동일 적용 확인 ──
  console.log("\n[5] ProcessCheckManager 공유 4허브 (허브별 디자인 분기 없음)");
  for (const [hub, title] of HUBS) {
    const r = await load(`/admin/integrated/processes/check/${hub}?org=encre`);
    const h1 = r.headings.filter((h) => h.tag === "h1");
    const h2 = r.headings.filter((h) => h.tag === "h2");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check(`${hub}: h1 '${title}' · h2 2개 · wave-dot 1개 · 중복 0`,
      h1[0]?.text === title && h2.length === 2 && r.seps.length === 1 && w?.headingBelow === "[액트 체크]",
      `h1=${h1[0]?.text} h2=${h2.length} seps=${r.seps.map((s) => s.variant).join(",") || "없음"}`);
    assertSpacing(`${hub}: 여백 동일`, w, EXPECT_DESKTOP);
  }

  // ── 6) 390px 반응형 ──
  console.log("\n[6] 390px 폭");
  await page.setViewportSize({ width: 390, height: 900 });
  {
    const r = await load(CLUB);
    assertSpacing("모바일 여백도 기준 페이지와 동일", r.seps.find((s) => s.variant === "wave-dot"), EXPECT_MOBILE);
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
