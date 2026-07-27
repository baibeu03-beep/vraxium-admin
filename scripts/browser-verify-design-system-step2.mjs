// 브라우저(인증 세션) 검증 — 디자인 시스템 확장 적용 Step 2 (/admin/team-parts/info).
//   기존 두 큰 섹션(팀 내역 / 클럽 현황) 사이의 단독 <Separator/>(fade) 를 PageSection
//   divider="wave-dot" 으로 교체한 결과를 확인한다.
//
// 확인 항목:
//   · 제목 개수 불변(h1/h2/h3/h4 · CardTitle 문구·순서 동일) · 신규 제목 0 · 위치 이동 0
//   · wave-dot 1개 · 중복 구분선 0(보이는 의미적 구분선 총 1개, fade 잔존 없음)
//   · 세로 여백 = /admin/periods/register 기준과 동일 computed 값
//   · 카드·표 내부 불변(카드/표/thead 셀 개수 핀)
//   · 일반 vs mode=test · org 3종 렌더 구조 동일
//
// 사용법: node scripts/browser-verify-design-system-step2.mjs
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

async function readPage(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
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
    return {
      headings,
      seps,
      cards: main.querySelectorAll('[data-slot="card"]').length,
      cardTitles: Array.from(main.querySelectorAll('[data-slot="card-title"]')).map((c) => txt(c)),
      tables: main.querySelectorAll("table").length,
      headerCells: main.querySelectorAll("thead th").length,
      bodyRows: main.querySelectorAll("tbody tr").length,
      // 요약 섹션(점선 테두리)·클럽 표의 구조적 border 는 그대로 남아 있어야 한다.
      dashedBoxes: main.querySelectorAll(".border-dashed").length,
    };
  });
}

const structureFingerprint = (r) =>
  JSON.stringify({
    headings: r.headings.map((h) => [h.tag, h.accent, h.fontSize]),
    cardTitles: r.cardTitles,
    seps: r.seps.map((s) => [s.variant, s.boxMarginTop, s.boxMarginBottom, s.sectionMarginTop, s.stackRowGap]),
    cards: r.cards, tables: r.tables, headerCells: r.headerCells, dashedBoxes: r.dashedBoxes,
  });

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

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

let refSpacing = null;

try {
  // ── 0) 기준 페이지 여백 SoT 재확인 ──
  console.log("\n[0] 기준 /admin/periods/register (여백 SoT)");
  {
    const r = await load("/admin/periods/register");
    const w = r.seps.find((s) => s.variant === "wave-dot");
    check("wave-dot 1개 · 구분선 총 1개", r.seps.length === 1 && !!w);
    if (w) {
      refSpacing = w;
      console.log(`    rowGap=${w.stackRowGap} · section mt=${w.sectionMarginTop} · divider mt/mb=${w.boxMarginTop}/${w.boxMarginBottom}`);
    }
  }

  // ── 1) /admin/team-parts/info (통합 경로) ──
  console.log("\n[1] /admin/team-parts/info");
  let fp = null;
  {
    const r = await load("/admin/team-parts/info");
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    const fade = r.seps.filter((s) => s.variant === "fade");

    // 적용 전 기준: 제목은 CardTitle 2개("팀 내역"·"클럽 현황")뿐이고 h1~h4 는 0개였다.
    check("h1~h4 0개(신규 제목 0 · 승격 0)", r.headings.length === 0,
      r.headings.map((h) => `${h.tag}:${h.text}`).join(" | "));
    check("CardTitle 2개 · 문구/순서 불변", r.cardTitles.length === 2 && r.cardTitles[0] === "팀 내역" && r.cardTitles[1] === "클럽 현황",
      r.cardTitles.join(" | "));
    check("wave-dot 1개", wave.length === 1);
    check("기존 fade 구분선 잔존 0(중복 구분선 0)", fade.length === 0, `fade=${fade.length}`);
    check("보이는 의미적 구분선 총 1개", r.seps.length === 1, `총 ${r.seps.length}개: ${r.seps.map((s) => s.variant).join(",")}`);
    check("구분선이 section(PageSection) 안에 위치", wave[0]?.sectionTag === "section", wave[0]?.sectionTag ?? "-");
    check("카드 2개 · 표 1개 유지", r.cards === 2 && r.tables === 1,
      `cards=${r.cards} tables=${r.tables} th=${r.headerCells} rows=${r.bodyRows}`);
    check("요약 섹션 점선 테두리 유지(구조적 border 불변)", r.dashedBoxes >= 1, `dashed=${r.dashedBoxes}`);
    if (wave.length === 1 && refSpacing) {
      const w = wave[0];
      const same =
        w.boxMarginTop === refSpacing.boxMarginTop &&
        w.boxMarginBottom === refSpacing.boxMarginBottom &&
        w.sectionMarginTop === refSpacing.sectionMarginTop &&
        w.stackRowGap === refSpacing.stackRowGap;
      check("세로 여백 = 기준 페이지와 동일", same,
        `rowGap=${w.stackRowGap} mt=${w.sectionMarginTop} divider=${w.boxMarginTop}/${w.boxMarginBottom}`);
      check("구분선 위·아래 대칭", w.boxMarginTop === w.boxMarginBottom, `${w.boxMarginTop} / ${w.boxMarginBottom}`);
    }
    fp = structureFingerprint(r);
  }

  // ── 2) mode=test 구조 동일 ──
  console.log("\n[2] /admin/team-parts/info?mode=test");
  {
    const r = await load("/admin/team-parts/info?mode=test");
    check("일반 vs mode=test 렌더 구조 동일", structureFingerprint(r) === fp);
  }

  // ── 3) org 3종 동일 컴포넌트 ──
  console.log("\n[3] org 3종 (동일 컴포넌트·동일 구분선)");
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await load(`/admin/team-parts/info?org=${org}`);
    const wave = r.seps.filter((s) => s.variant === "wave-dot");
    check(`org=${org}: wave-dot 1개 · fade 0 · h1~h4 0개 · CardTitle 2개`,
      wave.length === 1 && r.seps.length === 1 && r.headings.length === 0 && r.cardTitles.length === 2,
      `seps=${r.seps.map((s) => s.variant).join(",")} titles=${r.cardTitles.join("|")}`);
  }

  // ── 4) org + mode=test 조합 ──
  console.log("\n[4] org=encre&mode=test 조합");
  {
    const r = await load("/admin/team-parts/info?org=encre&mode=test");
    const base = await load("/admin/team-parts/info?org=encre");
    check("org+mode=test 렌더 구조 동일", structureFingerprint(r) === structureFingerprint(base));
  }

  // ── 5) 390px 반응형 ──
  console.log("\n[5] 390px 폭");
  await page.setViewportSize({ width: 390, height: 900 });
  {
    const ref = await load("/admin/periods/register");
    const r = await load("/admin/team-parts/info");
    const rw = r.seps.find((s) => s.variant === "wave-dot");
    const fw = ref.seps.find((s) => s.variant === "wave-dot");
    check("모바일 여백도 기준 페이지와 동일",
      !!rw && !!fw && rw.stackRowGap === fw.stackRowGap && rw.sectionMarginTop === fw.sectionMarginTop && rw.boxMarginTop === fw.boxMarginTop,
      rw ? `rowGap=${rw.stackRowGap} mt=${rw.sectionMarginTop} divider=${rw.boxMarginTop}/${rw.boxMarginBottom}` : "wave-dot 없음");
    check("모바일 구분선 위·아래 대칭", !!rw && rw.boxMarginTop === rw.boxMarginBottom);
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
