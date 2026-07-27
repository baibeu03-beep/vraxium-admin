// 브라우저(인증 세션) + HTTP 검증 — /admin/integrated/processes/check/* 카드 디자인 적용.
//
// 검증 목표(라인 개설 화면과 동일한 디자인 언어인지):
//   ① 좌측 accent border 4px (색 있음 / 투명 아님)
//   ② CardHeader 가 있는 카드는 헤더 틴트 + 헤더-본문 경계선 + 제목 앞 accent 도트
//   ③ 카드 외곽선(ring) + shadow-sm 2층
//   ④ CardHeader 가 없는 카드(액트 목록)는 첫 줄(요약 칩)이 상단 밴드 — 카드 상단·좌우 끝까지 틴트
//   ⑤ 라이트/다크 모두 적용 + 카드 개수·폭 동일(레이아웃 무변경)
//   ⑥ ORG × MODE(operating/test) 전 조합에서 동일한 디자인 계약(디자인이 mode/org 로 분기하지 않음)
//   ⑦ 반응형 — 모바일(390)/태블릿(820)/데스크톱(1440) 에서 가로 오버플로 없음
//   ⑧ HTTP API — 일반/테스트 모드 응답 상태·DTO 키가 동일(디자인 변경이 DTO 를 건드리지 않음)
//
// 사용법: node scripts/browser-verify-process-check-card-design.mjs
//   환경변수: SMOKE_BASE_URL(기본 http://localhost:3000) · SMOKE_ADMIN_EMAIL · SMOKE_ORGS(쉼표구분)
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

// 페이지의 모든 Card 를 읽어 디자인 계약 관련 계산값만 추출(라인 개설 검증 스크립트와 동일 계약).
async function readCards(page) {
  return page.evaluate(() => {
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
        boxShadow: cs.boxShadow,
        shadowLayers: (cs.boxShadow.match(/rgba?\(/g) ?? []).length,
        cardBg: cs.backgroundColor,
        hasHeader: !!header,
        headerBg: hs ? hs.backgroundColor : null,
        headerTinted: !!hs && !transparent(hs.backgroundColor) && hs.backgroundColor !== cs.backgroundColor,
        headerBorderBottom: hs ? Math.round(parseFloat(hs.borderBottomWidth) || 0) : 0,
        titleDot: !!title && !!title.querySelector('span[aria-hidden="true"].rounded-full'),
        // CardHeader 가 없는 카드: CardContent 안의 '요약 칩 줄'이 상단 밴드 역할.
        band: (() => {
          if (header) return null;
          const el = card.querySelector('[data-slot="card-content"] [data-pc-band]');
          if (!el) return null;
          const bs = getComputedStyle(el);
          const cb = card.getBoundingClientRect();
          const eb = el.getBoundingClientRect();
          return {
            tinted: !transparent(bs.backgroundColor) && bs.backgroundColor !== cs.backgroundColor,
            topOffset: Math.round(eb.top - cb.top),
            leftInset: Math.round(eb.left - cb.left),
            rightInset: Math.round(cb.right - eb.right),
            borderBottom: Math.round(parseFloat(bs.borderBottomWidth) || 0),
          };
        })(),
        width: Math.round(card.getBoundingClientRect().width),
      };
    });
  });
}

// 가로 오버플로(반응형) — **본문(main) 기준**으로 측정한다.
//   ⚠ 어드민 셸 헤더(세션/사용자 블록)는 390px 에서 원래부터 문서 폭을 넘긴다(모든 어드민 페이지 공통,
//     /admin/periods/register·line-opening 도 동일 = 485px). 이 검증의 대상은 프로세스 체크 본문이므로
//     document.scrollWidth 가 아니라 main 의 내부 오버플로만 본다(셸 회귀는 별도 과제).
//   계약 = "카드가 본문 폭을 넘지 않는다". main 자체의 오버플로는 셸 + 공용 주차 select(min-w-200px)에서
//   오는 기존 조건이라 참고값으로만 남긴다.
async function readOverflow(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const c = main ? main.clientWidth : 0;
    const wide = main
      ? Array.from(main.querySelectorAll('[data-slot="card"]'))
          .filter((el) => el.getBoundingClientRect().width > c + 1).length
      : 0;
    return {
      wideCards: wide,
      mainScrollW: main ? main.scrollWidth : 0,
      mainClientW: c,
      docScrollW: document.documentElement.scrollWidth,
      viewportW: window.innerWidth,
    };
  });
}

const accentCards = (cards) => cards.filter((c) => c.leftBorderWidth === 4 && !c.leftBorderTransparent);

const assertAccentCard = (label, card, { header = true, dot = true } = {}) => {
  if (!card) return check(label, false, "카드를 찾지 못함");
  check(`${label} · 좌측 accent 4px`, card.leftBorderWidth === 4 && !card.leftBorderTransparent,
    `${card.leftBorderWidth}px ${card.leftBorderColor}`);
  check(`${label} · 외곽선 강화(ring+shadow 2층)`, card.shadowLayers >= 2, card.boxShadow.slice(0, 70));
  if (header) {
    check(`${label} · 헤더 틴트`, card.headerTinted, `header ${card.headerBg} / card ${card.cardBg}`);
    check(`${label} · 헤더-본문 경계선`, card.headerBorderBottom >= 1, `${card.headerBorderBottom}px`);
  }
  if (dot) check(`${label} · 제목 accent 도트`, card.titleDot);
};

const findCard = (cards, name) => cards.find((c) => (c.title ?? "").startsWith(name)) ?? null;

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
const cookies = await makeAdminCookies();
await context.addCookies(cookies);
const page = await context.newPage();

// dev 서버는 라우트별 최초 컴파일이 오래 걸리고, 보드가 주기적으로 재조회하는 화면은
//   networkidle 에 도달하지 않을 수 있다 → domcontentloaded + 카드 등장 대기로 바꾼다.
const load = async (url, { expectCard = true } = {}) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await page.waitForTimeout(3000);
    }
  }
  if (expectCard) {
    try {
      await page.waitForSelector('[data-slot="card"]', { timeout: 60000 });
    } catch {
      /* 카드가 없는 화면(권한/빈 상태)도 그대로 계측한다 */
    }
  }
  await page.waitForTimeout(1200);
  return readCards(page);
};

const setTheme = async (theme) => {
  await page.evaluate((t) => {
    const root = document.documentElement;
    if (t === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try { window.localStorage.setItem("vraxium-theme", t); } catch {}
  }, theme);
  await page.waitForTimeout(400);
};

const ORGS = (process.env.SMOKE_ORGS ?? "encre,oranke,phalanx").split(",").map((s) => s.trim()).filter(Boolean);
const BASE_PATH = "/admin/integrated/processes/check";
// 하위 페이지 전수 — 4개 허브(공용 ProcessCheckManager) + 변동 액트(독립).
const HUBS = ["info", "experience", "competency", "club"];
const SUBPAGES = [...HUBS.map((h) => ({ slug: h, kind: "hub" })), { slug: "irregular", kind: "irregular" }];

try {
  // ── ① ORG × MODE × 하위페이지 — 카드 디자인 계약 ──────────────────────────────
  //   같은 하위페이지의 디자인 계약 결과(accent/틴트/도트 개수)가 org/mode 무관 동일해야 한다.
  const contractByPage = {}; // slug -> Set(직렬화된 계약 요약)
  for (const org of ORGS) {
    for (const mode of ["operating", "test"]) {
      for (const { slug, kind } of SUBPAGES) {
        const url = `${BASE_PATH}/${slug}?org=${org}${mode === "test" ? "&mode=test" : ""}`;
        console.log(`\n[${org}/${mode}] ${slug}`);
        const cards = await load(url);
        check("카드 렌더됨", cards.length > 0, `${cards.length}개`);
        const accented = accentCards(cards);
        check("모든 카드에 좌측 accent 적용(누락 0)", accented.length === cards.length,
          `${accented.length}/${cards.length} · 누락: ${cards.filter((c) => !accented.includes(c)).map((c) => c.title ?? "(제목없음)").join(" | ") || "-"}`);
        // 헤더 있는 카드는 틴트 + 경계선 + 도트가 모두 있어야 한다.
        const headed = cards.filter((c) => c.hasHeader);
        check("헤더 카드 전부 틴트+경계선+도트",
          headed.every((c) => c.headerTinted && c.headerBorderBottom >= 1 && c.titleDot),
          headed.filter((c) => !(c.headerTinted && c.headerBorderBottom >= 1 && c.titleDot))
            .map((c) => c.title).join(" | ") || `${headed.length}개 정상`);
        check("모든 카드 외곽선 2층(ring+shadow)", cards.every((c) => c.shadowLayers >= 2));

        if (kind === "hub") {
          assertAccentCard("상태창 1", findCard(cards, "상태창 1"));
          assertAccentCard("로그창", findCard(cards, "로그창"));
          // 액트 목록 카드(제목 없음) — 상단 밴드가 카드 상단/좌우 끝까지 차야 한다.
          const headerless = cards.filter((c) => !c.hasHeader);
          if (headerless.length > 0) {
            for (const c of headerless) {
              check("액트 목록 카드 · 좌측 accent 4px", c.leftBorderWidth === 4 && !c.leftBorderTransparent,
                `${c.leftBorderWidth}px ${c.leftBorderColor}`);
              if (c.band) {
                check("액트 목록 카드 · 상단 밴드 틴트", c.band.tinted);
                check("액트 목록 카드 · 밴드가 카드 상단/좌우 끝까지",
                  c.band.topOffset === 0 && c.band.leftInset === 4 && c.band.rightInset === 0,
                  `top ${c.band.topOffset} / left ${c.band.leftInset} / right ${c.band.rightInset}`);
                check("액트 목록 카드 · 밴드 하단 경계선", c.band.borderBottom >= 1);
              }
            }
          }
        } else {
          assertAccentCard("변동 액트 가동 · 신청", findCard(cards, "변동 액트 가동"));
          // 통계 7칸 스트립은 Card 가 아니라 div — 좌측 accent 4px 가 살아 있는지 별도 실측한다
          //   (tailwind-merge 에서 `border` 가 `border-l-4` 를 지우는 순서 함정 회귀 방지).
          const strip = await page.evaluate(() => {
            const el = document.querySelector("main .divide-x.rounded-md.border");
            if (!el) return null;
            const cs = getComputedStyle(el);
            return {
              leftBorderWidth: Math.round(parseFloat(cs.borderLeftWidth) || 0),
              leftBorderColor: cs.borderLeftColor,
              topBorderWidth: Math.round(parseFloat(cs.borderTopWidth) || 0),
            };
          });
          check("통계 스트립 · 좌측 accent 4px", strip?.leftBorderWidth === 4,
            strip ? `${strip.leftBorderWidth}px ${strip.leftBorderColor} (top ${strip.topBorderWidth}px)` : "스트립 없음");
        }

        // 디자인 계약 요약(제목 목록 + accent/틴트/도트 플래그) — org/mode 간 동일해야 한다.
        const summary = JSON.stringify(
          cards.map((c) => [c.title, c.leftBorderWidth, c.headerTinted, c.titleDot, c.hasHeader]),
        );
        (contractByPage[slug] ??= new Set()).add(summary);
      }
    }
  }
  console.log("\n[MODE/ORG 불변] 하위페이지별 디자인 계약이 org/mode 무관 동일한가");
  for (const [slug, set] of Object.entries(contractByPage)) {
    // 데이터 개수에 따라 카드 개수가 달라질 수 있으므로, '카드마다 계약을 만족하는지'는 위에서 이미 검사했다.
    // 여기서는 계약 플래그가 org/mode 별로 서로 다른 규칙을 타지 않는지(=디자인 분기 없음)만 본다.
    const flagsets = [...set].map((s) =>
      JSON.stringify(JSON.parse(s).map(([, w, t, d, h]) => [w, t, d, h]).sort()),
    );
    const allSame = new Set(flagsets).size === 1;
    check(`${slug}: 디자인 플래그 조합 일치(org/mode 분기 없음)`, allSame,
      allSame ? `${set.size}개 조합 · 동일` : `서로 다른 조합 ${new Set(flagsets).size}종`);
  }

  // ── ② 라이트/다크 — 대표 org 로 전 하위페이지 ──────────────────────────────
  const ORG0 = ORGS[0];
  for (const { slug, kind } of SUBPAGES) {
    const url = `${BASE_PATH}/${slug}?org=${ORG0}`;
    console.log(`\n[라이트/다크] ${slug}`);
    const light = await load(url);
    await setTheme("dark");
    const dark = await readCards(page);
    check("다크에서 카드 개수·폭 동일(레이아웃 무변경)",
      JSON.stringify(dark.map((c) => [c.title, c.width])) === JSON.stringify(light.map((c) => [c.title, c.width])));
    check("다크에서 좌측 accent 유지(투명 아님)",
      dark.every((c) => c.leftBorderWidth === 4 && !c.leftBorderTransparent));
    check("다크에서 헤더 틴트 유지(카드 배경과 다름)",
      dark.filter((c) => c.hasHeader).every((c) => c.headerTinted),
      dark.filter((c) => c.hasHeader && !c.headerTinted).map((c) => c.title).join(" | ") || "-");
    if (kind === "hub") {
      assertAccentCard("상태창 1(다크)", findCard(dark, "상태창 1"));
      assertAccentCard("로그창(다크)", findCard(dark, "로그창"));
    }
    await setTheme("light");
  }

  // ── ③ 반응형 — 모바일/태블릿/데스크톱 가로 오버플로 없음 ─────────────────────
  for (const vp of [{ w: 390, h: 900, name: "모바일" }, { w: 820, h: 1100, name: "태블릿" }, { w: 1440, h: 1200, name: "데스크톱" }]) {
    console.log(`\n[반응형 ${vp.name} ${vp.w}px]`);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    for (const { slug } of SUBPAGES) {
      await load(`${BASE_PATH}/${slug}?org=${ORG0}`);
      const o = await readOverflow(page);
      // 표는 자체 컨테이너에서만 가로 스크롤 — 카드가 본문 폭을 넘으면 레이아웃이 깨진 것.
      check(`${slug}: 카드가 본문 폭을 넘지 않음`, o.wideCards === 0,
        `main ${o.mainScrollW}/${o.mainClientW} (참고: 셸 포함 doc ${o.docScrollW} / vp ${o.viewportW})`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1400 });

  // ── ④ 회귀: 라인 개설 화면은 그대로 · 그 밖의 어드민 카드에 accent 유출 없음 ──
  console.log("\n[회귀] 다른 어드민 화면 카드 — accent/틴트 미적용 유지");
  for (const url of ["/admin/periods/register", "/admin/settings/process-check-windows"]) {
    const cards = await load(url);
    const unexpected = accentCards(cards).filter((c) => !/팀$/.test(c.title ?? ""));
    check(`${url}: 신규 accent 유출 0`, unexpected.length === 0,
      unexpected.map((c) => c.title).join(" | ") || `카드 ${cards.length}개`);
  }
  console.log("\n[회귀] 라인 개설 화면 카드 계약 유지");
  for (const p of ["practical-info", "practical-experience", "practical-competency"]) {
    const cards = await load(`/admin/integrated/line-opening/${p}?tab=open&org=${ORG0}`);
    assertAccentCard(`line-opening/${p} 상태창`, findCard(cards, "상태창"));
  }

  // ── ⑤ HTTP API — 일반/테스트 모드 상태·DTO 키 동일 ───────────────────────────
  console.log("\n[HTTP] 프로세스 체크 API — operating vs test");
  const apiGet = async (url) =>
    page.evaluate(async (u) => {
      const r = await fetch(u, { cache: "no-store" });
      let j = null;
      try { j = await r.json(); } catch {}
      return { status: r.status, ok: r.ok, success: j?.success ?? null, data: j?.data ?? null };
    }, url);
  const keysOf = (o) => (o && typeof o === "object" ? Object.keys(o).sort() : []);
  for (const org of ORGS) {
    for (const hub of HUBS) {
      const op = await apiGet(`/api/admin/processes/check?hub=${hub}&org=${org}`);
      const te = await apiGet(`/api/admin/processes/check?hub=${hub}&org=${org}&mode=test`);
      check(`${org}/${hub}: 두 모드 모두 200+success`,
        op.status === 200 && op.success === true && te.status === 200 && te.success === true,
        `op ${op.status}/${op.success} · test ${te.status}/${te.success}`);
      check(`${org}/${hub}: DTO 최상위 키 동일`,
        JSON.stringify(keysOf(op.data)) === JSON.stringify(keysOf(te.data)),
        `${keysOf(op.data).join(",")} vs ${keysOf(te.data).join(",")}`);
      check(`${org}/${hub}: summary 키 동일`,
        JSON.stringify(keysOf(op.data?.summary)) === JSON.stringify(keysOf(te.data?.summary)));
      const actKeys = (d) => keysOf(d?.acts?.[0]);
      if (actKeys(op).length && actKeys(te).length) {
        check(`${org}/${hub}: act row 키 동일`,
          JSON.stringify(actKeys(op)) === JSON.stringify(actKeys(te)),
          `${actKeys(op).length} vs ${actKeys(te).length} 키`);
      }
    }
    const iop = await apiGet(`/api/admin/processes/check/irregular?org=${org}`);
    const ite = await apiGet(`/api/admin/processes/check/irregular?org=${org}&mode=test`);
    check(`${org}/irregular: 두 모드 모두 200+success`,
      iop.status === 200 && iop.success === true && ite.status === 200 && ite.success === true,
      `op ${iop.status}/${iop.success} · test ${ite.status}/${ite.success}`);
    check(`${org}/irregular: DTO 최상위 키 동일`,
      JSON.stringify(keysOf(iop.data)) === JSON.stringify(keysOf(ite.data)));
    check(`${org}/irregular: summary 키 동일`,
      JSON.stringify(keysOf(iop.data?.summary)) === JSON.stringify(keysOf(ite.data?.summary)));
  }
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
