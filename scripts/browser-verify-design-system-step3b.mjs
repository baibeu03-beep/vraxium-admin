// 브라우저(인증 세션) 검증 — 디자인 시스템 확장 적용 Step 3-b
//   /admin/{integrated/,}line-opening/{practical-info,practical-experience,practical-competency}?tab=open
//
// 이 화면들은 최상위 섹션이 1개(space-y-* 컨테이너)라 PageSection 의 음수마진 상쇄가 통하지 않는다.
//   → 업무 섹션 경계([상태창+로그창] ↔ [라인 개설])에 이미 있던 공용 fade 구분선
//     (LineOpeningSectionDivider)을 wave-dot 으로 교체하고, 자체 padding 으로
//     기준 페이지(/admin/periods/register)와 동일한 48/56 대칭 여백을 만든다.
//
// 확인 항목:
//   · wave-dot 1개 · fade 잔존 0 · 중복 구분선 0 (경계당 1개)
//   · 구분선 위·아래 실측 간격 = 48px(390px) / 56px(≥768px) — 기준 페이지와 동일
//   · 구분선 직전 = 상태창/로그창 그룹, 직후 = 라인 개설 영역
//   · 제목 추가 0 · 제목 이동 0 · CardTitle 문구/순서 불변
//   · 카드/표 골격 불변 · mode=test · org 3종 · 통합/원본 경로 동일
//
// 사용법: node scripts/browser-verify-design-system-step3b.mjs
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
      const box = s.parentElement;                 // py-8 md:py-10 래퍼 또는 PageSection 의 mt/mb 블록
      const cs = (el) => (el ? getComputedStyle(el) : null);
      // 두 구조를 모두 지원한다:
      //   · LineOpeningSectionDivider — 래퍼가 space-y-* 부모의 중간 자식 → 래퍼의 형제가 곧 이웃 섹션.
      //   · PageSection — 래퍼가 <section> 의 첫 자식 → 이웃 섹션은 section 의 형제.
      const section = box?.closest("section") ?? null;
      const prev = box?.previousElementSibling
        ?? (section && section.contains(box) ? section.previousElementSibling : null)
        ?? null;
      const next = box?.nextElementSibling
        ?? (section && section.contains(box) ? section.nextElementSibling : null)
        ?? null;
      const r = s.getBoundingClientRect();
      return {
        variant: s.getAttribute("data-variant") ?? "",
        boxPaddingTop: cs(box)?.paddingTop ?? null,
        boxPaddingBottom: cs(box)?.paddingBottom ?? null,
        boxMarginTop: cs(box)?.marginTop ?? null,
        // 실제 눈에 보이는 위·아래 간격(이전 형제 하단 → 구분선 상단 / 구분선 하단 → 다음 형제 상단).
        gapAbove: prev ? Math.round(r.top - prev.getBoundingClientRect().bottom) : null,
        gapBelow: next ? Math.round(next.getBoundingClientRect().top - r.bottom) : null,
        prevText: prev ? txt(prev).slice(0, 22) : null,
        nextText: next ? txt(next).slice(0, 22) : null,
        prevCards: prev ? Array.from(prev.querySelectorAll('[data-slot="card-title"]')).map(txt) : [],
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

const fingerprint = (r) =>
  JSON.stringify({
    headings: r.headings, cardTitles: r.cardTitles,
    seps: r.seps.map((s) => [s.variant, s.boxPaddingTop, s.boxPaddingBottom, s.gapAbove, s.gapBelow]),
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

const PAGES = [
  ["practical-info", "실무 정보"],
  ["practical-experience", "실무 경험"],
  ["practical-competency", "실무 역량"],
];
const openUrl = (slug, extra = "") => `/admin/integrated/line-opening/${slug}?org=encre&tab=open${extra}`;

// 기준 페이지 경계 여백(PageSection divider) = 48px(390) / 56px(1440). 이 화면들도 같은 값이어야 한다.
const EXPECT_DESKTOP = 56;
const EXPECT_MOBILE = 48;

try {
  // ── 0) 기준 페이지 경계 여백 재확인 ──
  console.log("\n[0] 기준 /admin/periods/register 경계 여백");
  {
    const r = await load("/admin/periods/register");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check("wave-dot 1개", r.seps.length === 1 && !!w);
    console.log(`    기준 가시 여백: 위 ${w?.gapAbove}px / 아래 ${w?.gapBelow}px`);
    check(`기준 여백이 ${EXPECT_DESKTOP}px 대칭`, w?.gapAbove === EXPECT_DESKTOP && w?.gapBelow === EXPECT_DESKTOP,
      `${w?.gapAbove} / ${w?.gapBelow}`);
  }

  // ── 1) 3개 페이지 tab=open ──
  const fps = {};
  for (const [slug, title] of PAGES) {
    console.log(`\n[1] ${openUrl(slug)}`);
    const r = await load(openUrl(slug));
    const w = r.seps.find((s) => s.variant === "wave-dot");
    const fade = r.seps.filter((s) => s.variant === "fade");
    check(`h1 1개 = '${title}'(제목 추가/이동 0)`,
      r.headings.length === 1 && r.headings[0] === `h1:${title}`, r.headings.join(" | "));
    check("wave-dot 1개", !!w && r.seps.filter((s) => s.variant === "wave-dot").length === 1);
    check("기존 fade 잔존 0(교체 완료)", fade.length === 0, `fade=${fade.length}`);
    check("중복 구분선 0(경계당 1개)", r.seps.length === 1, `총 ${r.seps.length}: ${r.seps.map((s) => s.variant).join(",")}`);
    check("경계 위 = 상태창+로그창 그룹", w?.prevCards.includes("상태창") && w?.prevCards.includes("로그창"),
      (w?.prevCards ?? []).join(" / "));
    check("경계 아래 = 라인 개설 영역", !!w?.nextText, w?.nextText ?? "-");
    check(`구분선 위·아래 ${EXPECT_DESKTOP}px 대칭 = 기준 페이지 동일`,
      w?.gapAbove === EXPECT_DESKTOP && w?.gapBelow === EXPECT_DESKTOP,
      `위 ${w?.gapAbove}px / 아래 ${w?.gapBelow}px (padding ${w?.boxPaddingTop}/${w?.boxPaddingBottom})`);
    check("CardTitle 문구·순서 불변(이동 0)",
      r.cardTitles[0] === "상태창" && r.cardTitles[1] === "로그창", r.cardTitles.join(" | "));
    fps[slug] = fingerprint(r);
  }

  // ── 2) mode=test ──
  console.log("\n[2] mode=test 구조 동일");
  for (const [slug] of PAGES) {
    const r = await load(openUrl(slug, "&mode=test"));
    check(`${slug}: 일반 vs mode=test 동일`, fingerprint(r) === fps[slug]);
  }

  // ── 3) 통합 경로 ≡ 원본 경로 ──
  console.log("\n[3] 통합 경로 ≡ 원본 경로 (본문 기준)");
  for (const [slug] of PAGES) {
    const r = await load(`/admin/line-opening/${slug}?org=encre&tab=open`);
    check(`${slug}: 원본 경로 본문 구조 동일`, fingerprint(r) === fps[slug]);
  }

  // ── 4) org 3종 ──
  console.log("\n[4] org 3종 (동일 컴포넌트)");
  for (const [slug] of PAGES) {
    for (const org of ["encre", "oranke", "phalanx"]) {
      const r = await load(`/admin/integrated/line-opening/${slug}?org=${org}&tab=open`);
      const w = r.seps.find((s) => s.variant === "wave-dot");
      check(`${slug} org=${org}: wave-dot 1개 · fade 0 · ${EXPECT_DESKTOP}px 대칭`,
        r.seps.length === 1 && !!w && w.gapAbove === EXPECT_DESKTOP && w.gapBelow === EXPECT_DESKTOP,
        `seps=${r.seps.map((s) => s.variant).join(",") || "없음"} 위=${w?.gapAbove} 아래=${w?.gapBelow}`);
    }
  }

  // ── 5) [라인 관리] 탭 회귀 — Step 2-b 의 wave-dot 이 그대로인지(구분선 2개로 늘지 않았는지) ──
  console.log("\n[5] [라인 관리] 탭 회귀 (practical-info)");
  {
    const r = await load("/admin/integrated/line-opening/practical-info?org=encre");
    check("manage 탭 wave-dot 여전히 1개 · 중복 0", r.seps.length === 1 && r.seps[0].variant === "wave-dot",
      `총 ${r.seps.length}: ${r.seps.map((s) => s.variant).join(",")}`);
    check("CardTitle 2개 불변", r.cardTitles.length === 2
      && r.cardTitles[0] === "현재 상황" && r.cardTitles[1] === "주차별 개설 결과", r.cardTitles.join(" | "));
  }

  // ── 6) 390px 반응형 ──
  console.log("\n[6] 390px 폭");
  await page.setViewportSize({ width: 390, height: 900 });
  {
    const ref = await load("/admin/periods/register");
    const rw = ref.seps.find((s) => s.variant === "wave-dot");
    check(`기준 페이지 모바일 여백 ${EXPECT_MOBILE}px 대칭`,
      rw?.gapAbove === EXPECT_MOBILE && rw?.gapBelow === EXPECT_MOBILE, `${rw?.gapAbove} / ${rw?.gapBelow}`);
  }
  for (const [slug] of PAGES) {
    const r = await load(openUrl(slug));
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check(`${slug}: 모바일 ${EXPECT_MOBILE}px 대칭`,
      w?.gapAbove === EXPECT_MOBILE && w?.gapBelow === EXPECT_MOBILE,
      `위 ${w?.gapAbove}px / 아래 ${w?.gapBelow}px (padding ${w?.boxPaddingTop}/${w?.boxPaddingBottom})`);
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
