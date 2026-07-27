// 브라우저(인증 세션) 검증 — 디자인 시스템 확장 적용 Step 2-c
//   PageSection 의 parentGap 확장 + /admin/members?tab=info(중첩 탭) 적용.
//
// 핵심 검증 2축:
//   (1) 회귀 없음 — 이미 적용된 5개 페이지는 parentGap 기본값("stack")을 쓰므로 구분선 주변
//       computed 값(부모 rowGap · section marginTop · divider mt/mb)이 이전과 픽셀 동일해야 한다.
//       기대값은 이 스크립트에 상수로 못박아 둔다(1440px: 40/-40/56·56, 390px: 32/-32/48·48).
//   (2) 신규 — /admin/members?tab=info 는 중첩 탭의 기존 gap-6(24px)을 유지한 채,
//       구분선 위·아래만 48/56 대칭이 되어야 한다(부모 gap 은 24px 그대로).
//
// 사용법: node scripts/browser-verify-design-system-step2c.mjs
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
    const seps = Array.from(main.querySelectorAll('[data-slot="separator"]')).map((s) => {
      const box = s.parentElement;
      const section = box?.parentElement ?? null;
      const parent = section?.parentElement ?? null;
      const cs = (el) => (el ? getComputedStyle(el) : null);
      // 실제 눈에 보이는 위쪽 간격 = 이전 형제 하단 → 구분선 상단.
      const prev = section?.previousElementSibling ?? null;
      const visibleGapAbove = prev
        ? Math.round(s.getBoundingClientRect().top - prev.getBoundingClientRect().bottom)
        : null;
      return {
        variant: s.getAttribute("data-variant") ?? "",
        sectionTag: section?.tagName.toLowerCase() ?? null,
        sectionMarginTop: cs(section)?.marginTop ?? null,
        dividerMarginTop: cs(box)?.marginTop ?? null,
        dividerMarginBottom: cs(box)?.marginBottom ?? null,
        parentRowGap: cs(parent)?.rowGap ?? null,
        visibleGapAbove,
      };
    });
    return {
      seps,
      headings: Array.from(main.querySelectorAll("h1,h2,h3,h4")).map((h) => `${h.tagName.toLowerCase()}:${txt(h)}`),
      cardTitles: Array.from(main.querySelectorAll('[data-slot="card-title"]')).map(txt),
      cards: main.querySelectorAll('[data-slot="card"]').length,
      tables: main.querySelectorAll("table").length,
      headerCells: main.querySelectorAll("thead th").length,
    };
  });
}

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

// 기존 적용 5개 페이지 — parentGap 기본("stack") 사용 → 이 값이 변하면 회귀.
const STACK_PAGES = [
  ["/admin/periods/register", "기준(기간 관리)"],
  ["/admin/rest-management?org=encre", "휴식 관리"],
  ["/admin/team-parts/info", "팀 내역"],
  ["/admin/processes/register", "프로세스 관리"],
  ["/admin/integrated/line-opening/practical-info?org=encre", "실무 정보"],
];
// 부모 admin-section-stack(32/40) + 상쇄(-32/-40) + 구분선(48/56 대칭) → 가시 간격 48/56.
const EXPECT_DESKTOP = { parentRowGap: "40px", sectionMarginTop: "-40px", divider: "56px", visibleGapAbove: 56 };
const EXPECT_MOBILE = { parentRowGap: "32px", sectionMarginTop: "-32px", divider: "48px", visibleGapAbove: 48 };
// 중첩 탭(gap-6=24px) + 상쇄(-24px) + 구분선(48/56 대칭) → 부모 gap 은 24px 유지, 가시 간격은 48/56.
const EXPECT_GAP6_DESKTOP = { parentRowGap: "24px", sectionMarginTop: "-24px", divider: "56px", visibleGapAbove: 56 };
const EXPECT_GAP6_MOBILE = { parentRowGap: "24px", sectionMarginTop: "-24px", divider: "48px", visibleGapAbove: 48 };

const assertSpacing = (label, sep, exp) => {
  const ok = sep
    && sep.parentRowGap === exp.parentRowGap
    && sep.sectionMarginTop === exp.sectionMarginTop
    && sep.dividerMarginTop === exp.divider
    && sep.dividerMarginBottom === exp.divider
    && sep.visibleGapAbove === exp.visibleGapAbove;
  check(label, ok, sep
    ? `gap=${sep.parentRowGap} mt=${sep.sectionMarginTop} divider=${sep.dividerMarginTop}/${sep.dividerMarginBottom} 가시=${sep.visibleGapAbove}px`
    : "wave-dot 없음");
};

const INFO = "/admin/members?tab=info";

try {
  // ── 1) 회귀 검증(1440px) — 기존 5개 페이지 픽셀 동일 ──
  console.log("\n[1] 기존 적용 5개 페이지 회귀 검증 (1440px · parentGap 기본값)");
  for (const [url, name] of STACK_PAGES) {
    const r = await load(url);
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check(`${name}: wave-dot 1개 · 중복 구분선 0`, r.seps.length === 1 && !!w,
      `총 ${r.seps.length}: ${r.seps.map((s) => s.variant).join(",") || "없음"}`);
    assertSpacing(`${name}: 여백 픽셀 동일`, w, EXPECT_DESKTOP);
  }

  // ── 2) 신규 /admin/members?tab=info — gap-6 유지 + 대칭 경계 ──
  console.log(`\n[2] ${INFO} (중첩 탭 · parentGap="gap-6")`);
  let infoFp = null;
  {
    const r = await load(INFO);
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check("h1 1개 = '크루 관리'(제목 신규 추가 0)", r.headings.length === 1 && r.headings[0] === "h1:크루 관리",
      r.headings.join(" | "));
    check("CardTitle 2개 · 문구/순서 불변", r.cardTitles.length === 2
      && r.cardTitles[0] === "역대 누적" && r.cardTitles[1] === "주차별 데이터", r.cardTitles.join(" | "));
    check("wave-dot 1개 · 중복 구분선 0", r.seps.length === 1 && !!w,
      `총 ${r.seps.length}: ${r.seps.map((s) => s.variant).join(",") || "없음"}`);
    check("구분선이 section(PageSection) 안", w?.sectionTag === "section", w?.sectionTag ?? "-");
    check("부모 gap-6(24px) 유지 — admin-section-stack 으로 바뀌지 않음", w?.parentRowGap === "24px", w?.parentRowGap ?? "-");
    assertSpacing("gap-6 부모에서도 위·아래 48/56 대칭", w, EXPECT_GAP6_DESKTOP);
    check("카드 3개 · 표 1개 유지(내부 불변)", r.cards === 3 && r.tables === 1,
      `cards=${r.cards} tables=${r.tables} th=${r.headerCells}`);
    infoFp = JSON.stringify({ h: r.headings, t: r.cardTitles, s: r.seps.map((x) => x.variant), c: r.cards, tb: r.tables });
  }

  // ── 3) mode=test · org ──
  console.log("\n[3] mode=test · org 구조 동일");
  {
    const r = await load(`${INFO}&mode=test`);
    const fp = JSON.stringify({ h: r.headings, t: r.cardTitles, s: r.seps.map((x) => x.variant), c: r.cards, tb: r.tables });
    check("일반 vs mode=test 렌더 구조 동일", fp === infoFp);
    const w = r.seps.find((s) => s.variant === "wave-dot");
    assertSpacing("mode=test 여백 동일", w, EXPECT_GAP6_DESKTOP);
  }
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await load(`${INFO}&org=${org}`);
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check(`org=${org}: wave-dot 1개 · gap-6 유지`,
      r.seps.length === 1 && w?.parentRowGap === "24px",
      `seps=${r.seps.map((s) => s.variant).join(",")} gap=${w?.parentRowGap ?? "-"}`);
  }

  // ── 4) 크루 목록 탭(tab=list) 무접촉 ──
  console.log("\n[4] /admin/members (크루 목록 탭 · 적용 제외)");
  {
    const r = await load("/admin/members");
    check("구분선 0개(적용 안 함)", r.seps.length === 0, r.seps.map((s) => s.variant).join(",") || "없음");
    check("CardTitle '크루 목록' 유지", r.cardTitles.includes("크루 목록"), r.cardTitles.join(" | "));
    check("h1 1개", r.headings.filter((h) => h.startsWith("h1:")).length === 1, r.headings.join(" | "));
  }

  // ── 5) 390px 반응형 — 회귀 + 신규 ──
  console.log("\n[5] 390px 폭");
  await page.setViewportSize({ width: 390, height: 900 });
  for (const [url, name] of STACK_PAGES) {
    const r = await load(url);
    assertSpacing(`${name}: 모바일 여백 픽셀 동일`, r.seps.find((s) => s.variant === "wave-dot"), EXPECT_MOBILE);
  }
  {
    const r = await load(INFO);
    assertSpacing("크루 정보 탭: 모바일 gap-6 유지 + 48/48 대칭",
      r.seps.find((s) => s.variant === "wave-dot"), EXPECT_GAP6_MOBILE);
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
