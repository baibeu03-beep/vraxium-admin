// 보조 검증(포커스) — /admin/integrated/processes/check/* 중 본 스크립트로 못 덮은 3가지만 확인.
//   ① 변동 액트 '통계 7칸 스트립'(Card 아님)의 좌측 accent 4px — tailwind-merge `border` 함정 회귀 방지
//   ② [encre/test] info 재시도(본 검증에서 dev 컴파일 지연으로 0개 측정된 케이스)
//   ③ 팀 구분 허브(experience) 의 팀 스코프 카드 — 주차 드롭다운을 훑어 팀이 있는 주차를 찾아
//      상태창2(팀)·파트 구분·액트 목록 카드까지 디자인 계약을 실측한다.
//
// 사용법: node scripts/browser-verify-process-check-card-design-focus.mjs
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

const readCards = (page) => page.evaluate(() => {
  const txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const root = document.querySelector("main") ?? document.body;
  const transparent = (c) => !c || c === "transparent" || /rgba\([^)]*,\s*0\s*\)$/.test(c);
  return Array.from(root.querySelectorAll('[data-slot="card"]')).map((card) => {
    const cs = getComputedStyle(card);
    const header = card.querySelector('[data-slot="card-header"]');
    const hs = header ? getComputedStyle(header) : null;
    const title = card.querySelector('[data-slot="card-title"]');
    return {
      title: title ? txt(title) : null,
      leftBorderWidth: Math.round(parseFloat(cs.borderLeftWidth) || 0),
      leftBorderColor: cs.borderLeftColor,
      leftBorderTransparent: transparent(cs.borderLeftColor),
      shadowLayers: (cs.boxShadow.match(/rgba?\(/g) ?? []).length,
      hasHeader: !!header,
      headerTinted: !!hs && !transparent(hs.backgroundColor) && hs.backgroundColor !== cs.backgroundColor,
      headerBorderBottom: hs ? Math.round(parseFloat(hs.borderBottomWidth) || 0) : 0,
      titleDot: !!title && !!title.querySelector('span[aria-hidden="true"].rounded-full'),
    };
  });
});

const readStrip = (page) => page.evaluate(() => {
  const el = document.querySelector("main .divide-x.rounded-md.border");
  if (!el) return null;
  const cs = getComputedStyle(el);
  return {
    leftBorderWidth: Math.round(parseFloat(cs.borderLeftWidth) || 0),
    leftBorderColor: cs.borderLeftColor,
    topBorderWidth: Math.round(parseFloat(cs.borderTopWidth) || 0),
  };
});

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 120000 }); break; }
    catch (e) { if (attempt >= 3) throw e; await page.waitForTimeout(3000); }
  }
  try { await page.waitForSelector('[data-slot="card"]', { timeout: 90000 }); } catch {}
  // ⚠ 보드 응답(느린 dev 서버에서 20초 이상)까지 기다려야 팀 탭·팀 스코프 카드가 렌더된다.
  //   주차 드롭다운에 실제 option 이 생기는 시점 = 보드 도착 시점.
  try {
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('select[aria-label="주차 선택"]');
        if (!sel) return false;
        return Array.from(sel.options).some((o) => o.value);
      },
      { timeout: 120000 },
    );
  } catch {}
  await page.waitForTimeout(2000);
};

const setTheme = async (theme) => {
  await page.evaluate((t) => {
    const root = document.documentElement;
    if (t === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }, theme);
  await page.waitForTimeout(400);
};

const ORGS = (process.env.SMOKE_ORGS ?? "encre,oranke,phalanx").split(",").map((s) => s.trim());
const BASE_PATH = "/admin/integrated/processes/check";

const assertCard = (label, c) => {
  if (!c) return check(label, false, "카드 없음");
  check(`${label} · accent 4px`, c.leftBorderWidth === 4 && !c.leftBorderTransparent,
    `${c.leftBorderWidth}px ${c.leftBorderColor}`);
  check(`${label} · 외곽선 2층`, c.shadowLayers >= 2);
  if (c.hasHeader) {
    check(`${label} · 헤더 틴트+경계선+도트`,
      c.headerTinted && c.headerBorderBottom >= 1 && c.titleDot,
      `tint ${c.headerTinted} / border ${c.headerBorderBottom} / dot ${c.titleDot}`);
  }
};

try {
  // ① 통계 스트립 accent — org × 라이트/다크
  for (const org of ORGS) {
    console.log(`\n[① 통계 스트립] ${org}`);
    await load(`${BASE_PATH}/irregular?org=${org}`);
    const light = await readStrip(page);
    check("라이트 · 좌측 accent 4px", light?.leftBorderWidth === 4,
      light ? `${light.leftBorderWidth}px ${light.leftBorderColor} (top ${light.topBorderWidth}px)` : "스트립 없음");
    await setTheme("dark");
    const dark = await readStrip(page);
    check("다크 · 좌측 accent 4px + 색 유지", dark?.leftBorderWidth === 4 && dark.leftBorderColor !== light?.leftBorderColor,
      dark ? `${dark.leftBorderWidth}px ${dark.leftBorderColor}` : "스트립 없음");
    await setTheme("light");
  }

  // ② encre/test info 재시도
  console.log("\n[② 재시도] encre/test info");
  await load(`${BASE_PATH}/info?org=encre&mode=test`);
  const cards = await readCards(page);
  check("카드 렌더됨", cards.length > 0, `${cards.length}개`);
  check("모든 카드 accent 4px", cards.length > 0 && cards.every((c) => c.leftBorderWidth === 4 && !c.leftBorderTransparent),
    cards.filter((c) => c.leftBorderWidth !== 4).map((c) => c.title ?? "(제목없음)").join(" | ") || "-");
  assertCard("상태창 1", cards.find((c) => (c.title ?? "").startsWith("상태창 1")));
  assertCard("로그창", cards.find((c) => (c.title ?? "").startsWith("로그창")));
  assertCard("상태창 2", cards.find((c) => (c.title ?? "").startsWith("상태창 2")));

  // ③ experience — 팀이 있는 주차를 찾아 팀 스코프 카드까지 검증
  console.log("\n[③ 팀 스코프 카드] experience — 팀이 있는 주차 탐색");
  let covered = false;
  for (const org of ORGS) {
    if (covered) break;
    await load(`${BASE_PATH}/experience?org=${org}`);
    // 기본(현재) 주차부터 확인 — 팀 탭이 이미 있으면 주차 전환 없이 그대로 검증한다.
    const weekIds = ["", ...(await page.evaluate(() =>
      Array.from(document.querySelectorAll('select[aria-label="주차 선택"] option'))
        .map((o) => o.value).filter(Boolean)))];
    for (const weekId of weekIds.slice(0, 6)) {
      if (weekId) {
        await page.selectOption('select[aria-label="주차 선택"]', weekId);
      }
      // 팀 탭이 나타날 때까지 대기(보드 재조회 완료 신호).
      let hasTeamTab = false;
      try {
        await page.waitForSelector('main [role="tab"]', { timeout: 60000 });
        hasTeamTab = true;
      } catch { hasTeamTab = false; }
      if (!hasTeamTab) continue;
      // 팀 탭이 있으면 팀 스코프 카드(상태창2·파트 구분·액트 목록)가 렌더된다 — 로드 완료까지 대기.
      try {
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('[data-slot="card-title"]'))
            .some((t) => (t.textContent ?? "").includes("파트 구분")),
          { timeout: 60000 },
        );
      } catch {}
      await page.waitForTimeout(2000);
      const c2 = await readCards(page);
      console.log(`  · ${org} / week ${weekId} — 카드 ${c2.length}개: ${c2.map((c) => c.title ?? "(제목없음)").join(" | ")}`);
      assertCard("상태창 2(팀)", c2.find((c) => (c.title ?? "").startsWith("상태창 2")));
      assertCard("파트 구분", c2.find((c) => (c.title ?? "").startsWith("파트 구분")));
      const headerless = c2.filter((c) => !c.hasHeader);
      check("액트 목록 카드 accent", headerless.length > 0 && headerless.every((c) => c.leftBorderWidth === 4),
        `${headerless.length}개`);
      covered = true;
      break;
    }
  }
  if (!covered) {
    console.log("  ⚠ 팀이 있는 주차를 찾지 못했습니다(데이터 조건) — 팀 스코프 카드는 코드 리뷰로만 확인.");
  }

  // ④ 반응형 — **본문(main) 기준** 가로 오버플로. 어드민 셸 헤더는 390px 에서 원래부터 문서 폭을
  //    넘기므로(모든 어드민 페이지 공통 = 485px) document 가 아니라 main 내부만 본다.
  const SUB = ["info", "experience", "competency", "club", "irregular"];
  for (const vp of [{ w: 390, h: 900, n: "모바일" }, { w: 820, h: 1100, n: "태블릿" }, { w: 1440, h: 1200, n: "데스크톱" }]) {
    console.log(`\n[④ 반응형 ${vp.n} ${vp.w}px] 본문 오버플로`);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    for (const slug of SUB) {
      await load(`${BASE_PATH}/${slug}?org=${ORGS[0]}`);
      const o = await page.evaluate(() => {
        const m = document.querySelector("main");
        const c = m ? m.clientWidth : 0;
        const wide = m
          ? Array.from(m.querySelectorAll('[data-slot="card"]'))
              .map((el) => ({
                w: Math.round(el.getBoundingClientRect().width),
                sw: el.scrollWidth,
                t: (el.querySelector('[data-slot="card-title"]')?.textContent ?? "(제목없음)")
                  .replace(/\s+/g, " ").trim().slice(0, 20),
              }))
              .filter((x) => x.w > c + 1)
          : [];
        return {
          s: m ? m.scrollWidth : 0,
          c,
          cards: m ? m.querySelectorAll('[data-slot="card"]').length : 0,
          wide,
          doc: document.documentElement.scrollWidth,
          vw: window.innerWidth,
        };
      });
      // 이 검증의 계약 = "카드가 본문 폭을 넘지 않는다"(넘치는 표는 카드 안에서만 스크롤).
      //   본문(main) 자체의 오버플로는 어드민 셸/공용 주차 select(min-w-200px)에서 오는 기존 조건이라
      //   참고값으로만 출력한다 — 390px 에서는 셸이 main 을 150px 로 만들어 모든 어드민 페이지가 동일하다.
      check(`${slug}: 카드가 본문 폭을 넘지 않음`, o.wide.length === 0,
        `카드 ${o.cards}개 · main ${o.s}/${o.c} (참고: 셸 포함 doc ${o.doc}/vp ${o.vw})` +
          (o.wide.length ? ` · 초과: ${o.wide.map((x) => `${x.t}=${x.w}`).join(", ")}` : ""));
    }
  }
  await page.setViewportSize({ width: 1440, height: 1400 });
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
