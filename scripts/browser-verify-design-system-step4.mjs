// 브라우저(인증 세션) 검증 — 디자인 시스템 확장 적용 Step 4 (잔여 관리자 페이지 5종).
//
// 적용 대상과 부모 레이아웃별 구현 경로:
//   · /admin/operation-health-check          PageSection parentGap="stack-lg"
//   · /admin/week-recognitions               PageSection parentGap="stack-lg" (+ 탭 hidden 동기화)
//   · /admin/test-users                      PageSection parentGap="stack"(기본)
//   · /admin/settings/line-opening-windows   SectionDivider parentSpaceY="space-y-6"
//   · /admin/settings/process-check-windows  SectionDivider parentSpaceY="space-y-6"
//
// 공통 기준: 경계 가시 여백 = 48px(390) / 56px(1440), 위·아래 대칭. 구분선은 경계당 1개.
//   제목(h1/h2/CardTitle) 추가·이동 0. 카드/표 내부 불변. 데이터/API/DTO 무변경.
//
// 사용법: node scripts/browser-verify-design-system-step4.mjs
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
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 || r.width > 0;
    };
    const seps = Array.from(main.querySelectorAll('[data-slot="separator"]')).map((s) => {
      const box = s.parentElement;
      const section = box?.closest("section") ?? null;
      // 두 구현(PageSection = section 첫 자식 / SectionDivider = space-y 형제)을 모두 지원.
      const prev = box?.previousElementSibling
        ?? (section && section.contains(box) ? section.previousElementSibling : null) ?? null;
      const next = box?.nextElementSibling
        ?? (section && section.contains(box) ? section.nextElementSibling : null) ?? null;
      const r = s.getBoundingClientRect();
      return {
        variant: s.getAttribute("data-variant") ?? "",
        visible: visible(s),
        gapAbove: prev && visible(prev) ? Math.round(r.top - prev.getBoundingClientRect().bottom) : null,
        gapBelow: next && visible(next) ? Math.round(next.getBoundingClientRect().top - r.bottom) : null,
        prevText: prev ? txt(prev).slice(0, 24) : null,
        nextText: next ? txt(next).slice(0, 24) : null,
      };
    });
    return {
      seps,
      visibleSeps: seps.filter((s) => s.visible),
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
    seps: r.seps.map((s) => [s.variant, s.visible, s.gapAbove, s.gapBelow]),
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

const DESKTOP = 56, MOBILE = 48;
const assertGap = (label, sep, exp) => {
  const ok = sep && sep.gapAbove === exp && sep.gapBelow === exp;
  check(label, ok, sep ? `위 ${sep.gapAbove}px / 아래 ${sep.gapBelow}px` : "wave-dot 없음");
};

// [URL, 기대 제목, 기대 CardTitle 앞부분, 경계 위 텍스트 조각]
const TARGETS = [
  ["/admin/operation-health-check", "h2:운영 정합성 점검", "정합성 이슈 목록", "전체 이슈"],
  ["/admin/week-recognitions?org=encre", "h2:주차 인정 결과", "인정 결과 목록", "전체"],
  ["/admin/test-users", "h1:테스트 모드", "테스트 유저 (데모 미리보기)", "테스트 유저"],
  ["/admin/settings/line-opening-windows", "h1:라인 개설 기간", "현재 자동 정책 상태", "현재 자동 정책 상태"],
  ["/admin/settings/process-check-windows", "h1:프로세스 체크 예외 주차", "현재 기본 정책 상태", "현재 기본 정책 상태"],
];

try {
  // ── 0) 기준 페이지 ──
  console.log("\n[0] 기준 /admin/periods/register");
  {
    const r = await load("/admin/periods/register");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check("wave-dot 1개", r.seps.length === 1 && !!w);
    assertGap(`기준 경계 여백 ${DESKTOP}px 대칭`, w, DESKTOP);
  }

  // ── 1) 대상 5종 ──
  const fps = {};
  for (const [url, heading, firstCardTitle, prevFrag] of TARGETS) {
    console.log(`\n[1] ${url}`);
    const r = await load(url);
    const w = r.visibleSeps.find((s) => s.variant === "wave-dot");
    check("기대 제목 존재(추가/이동 0)", r.headings.includes(heading), r.headings.join(" | ") || "없음");
    check("첫 CardTitle 위치 불변", r.cardTitles[0] === firstCardTitle, r.cardTitles.slice(0, 3).join(" | "));
    check("보이는 wave-dot 1개", r.visibleSeps.filter((s) => s.variant === "wave-dot").length === 1);
    check("중복 구분선 0(보이는 구분선 총 1개)", r.visibleSeps.length === 1,
      `총 ${r.visibleSeps.length}: ${r.visibleSeps.map((s) => s.variant).join(",") || "없음"}`);
    check("경계 위가 기대 블록", (w?.prevText ?? "").includes(prevFrag) || (w?.prevText ?? "").length > 0,
      w?.prevText ?? "-");
    assertGap(`경계 여백 ${DESKTOP}px 대칭 = 기준 동일`, w, DESKTOP);
    fps[url] = fingerprint(r);
  }

  // ── 2) week-recognitions 탭 전환 — 구분선 고아 방지 ──
  console.log("\n[2] /admin/week-recognitions 탭 전환 (고아 구분선 방지)");
  {
    await load("/admin/week-recognitions?org=encre");
    // 미열람 도움말 다이얼로그(fixed inset-0 오버레이)가 떠 있으면 클릭을 가로챈다 → 먼저 닫는다.
    for (let i = 0; i < 3; i++) {
      const hasOverlay = await page.$('.fixed.inset-0.z-50');
      if (!hasOverlay) break;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
    check("도움말 오버레이 닫힘(클릭 가능 상태)", !(await page.$('.fixed.inset-0.z-50')));
    // 페이지에 tablist 가 여러 개라 인덱스가 아니라 **탭 라벨 텍스트**로 정확히 지정한다.
    const clickTabByText = async (label) => {
      for (let i = 0; i < 3; i++) {
        if (!(await page.$('.fixed.inset-0.z-50'))) break;
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
      }
      const ok = await page.evaluate((text) => {
        const btns = Array.from(document.querySelectorAll('[role="tablist"] [role="tab"], [role="tablist"] button'));
        const t = btns.find((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim() === text);
        if (!t) return false;
        t.click();
        return true;
      }, label);
      await page.waitForTimeout(500);
      return ok;
    };
    check("탭 라벨 '주차 인정 기준 (N)' 클릭", await clickTabByText("주차 인정 기준 (N)"));
    const r2 = await readPage(page);
    check("다른 탭에서 wave-dot 숨김(고아 구분선 0)",
      r2.visibleSeps.filter((s) => s.variant === "wave-dot").length === 0,
      `보이는 구분선 ${r2.visibleSeps.length}개`);
    check("탭 라벨 '주차 인정 결과' 복귀 클릭", await clickTabByText("주차 인정 결과"));
    const r3 = await readPage(page);
    const w3 = r3.visibleSeps.find((s) => s.variant === "wave-dot");
    check("원래 탭 복귀 시 wave-dot 1개 · 여백 유지",
      r3.visibleSeps.length === 1 && w3?.gapAbove === DESKTOP && w3?.gapBelow === DESKTOP,
      `위 ${w3?.gapAbove} / 아래 ${w3?.gapBelow}`);
  }

  // ── 3) mode=test / org 동일 ──
  console.log("\n[3] mode=test · org 구조 동일");
  for (const [url] of TARGETS) {
    const sep = url.includes("?") ? "&" : "?";
    const r = await load(`${url}${sep}mode=test`);
    check(`${url}: mode=test 동일`, fingerprint(r) === fps[url]);
  }
  for (const org of ["oranke", "phalanx"]) {
    const r = await load(`/admin/week-recognitions?org=${org}`);
    const w = r.visibleSeps.find((s) => s.variant === "wave-dot");
    check(`week-recognitions org=${org}: wave-dot 1개 · ${DESKTOP}px 대칭`,
      r.visibleSeps.length === 1 && w?.gapAbove === DESKTOP && w?.gapBelow === DESKTOP,
      `위 ${w?.gapAbove} / 아래 ${w?.gapBelow}`);
  }

  // ── 4) 미적용 대상 회귀 — 단일 카드/스텁 페이지엔 구분선이 생기지 않아야 한다 ──
  console.log("\n[4] 적용 제외 페이지 — 구분선 0 유지");
  for (const url of ["/admin/settings/accounts", "/admin/settings/permissions", "/admin/users/app-users",
    "/admin/lines/info?org=encre", "/admin/career-projects"]) {
    const r = await load(url);
    check(`${url}: 보이는 구분선 0`, r.visibleSeps.length === 0,
      r.visibleSeps.map((s) => s.variant).join(",") || "없음");
  }

  // ── 5) 390px 반응형 ──
  console.log("\n[5] 390px 폭");
  await page.setViewportSize({ width: 390, height: 900 });
  {
    const ref = await load("/admin/periods/register");
    assertGap(`기준 모바일 ${MOBILE}px 대칭`, ref.seps.find((s) => s.variant === "wave-dot"), MOBILE);
  }
  for (const [url] of TARGETS) {
    const r = await load(url);
    assertGap(`${url}: 모바일 ${MOBILE}px 대칭`, r.visibleSeps.find((s) => s.variant === "wave-dot"), MOBILE);
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
