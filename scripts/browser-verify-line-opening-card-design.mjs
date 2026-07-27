// 브라우저(인증 세션) 검증 — /admin/integrated/line-opening/* 카드 디자인 개선.
//
// 검증 대상(실무 정보/경험/역량 3화면, ?tab=open):
//   ① 상태창 / 로그창  ② 그 아래 '라인 개설' 카드
// 공통 디자인 계약(components/admin/lineOpeningCardStyles.tsx):
//   · 좌측 accent border 4px (색 있음 / 투명 아님)
//   · 헤더 영역 은은한 배경 틴트 (헤더 배경 ≠ 카드 배경, 헤더가 있는 카드만)
//   · 카드 외곽선(ring) 존재감 강화 — box-shadow 에 ring + shadow-sm 두 층
//   · 라이트/다크 모두 적용(다크에서 색이 죽지 않음)
// 회귀 방지:
//   · 라인 개설 화면 밖의 어드민 카드(다른 페이지)는 좌측 border 0 / 헤더 틴트 없음 유지
//   · 카드 개수·CardTitle 목록·표 개수가 라이트/다크 동일(레이아웃/내용 무변경)
//
// 사용법: node scripts/browser-verify-line-opening-card-design.mjs
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

// 페이지의 모든 Card 를 읽어 디자인 계약 관련 계산값만 추출.
async function readCards(page) {
  return page.evaluate(() => {
    const txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("main") ?? document.body;
    const transparent = (c) =>
      !c || c === "transparent" || /rgba\([^)]*,\s*0\s*\)$/.test(c);
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
        // ring(1px spread) + shadow-sm 두 층이면 box-shadow 에 색이 2개 이상 잡힌다.
        shadowLayers: (cs.boxShadow.match(/rgba?\(/g) ?? []).length,
        cardBg: cs.backgroundColor,
        hasHeader: !!header,
        headerBg: hs ? hs.backgroundColor : null,
        headerTinted: !!hs && !transparent(hs.backgroundColor) && hs.backgroundColor !== cs.backgroundColor,
        headerBorderBottom: hs ? Math.round(parseFloat(hs.borderBottomWidth) || 0) : 0,
        // CardHeader 가 없는 카드: CardContent 첫 줄(탭 바)이 헤더 밴드 역할 — 카드 상단까지 틴트가 차야 한다.
        band: (() => {
          if (header) return null;
          const el = card.querySelector('[data-slot="card-content"] [role="tablist"]');
          if (!el) return null;
          const bs = getComputedStyle(el);
          const cb = card.getBoundingClientRect();
          const eb = el.getBoundingClientRect();
          return {
            tinted: !transparent(bs.backgroundColor) && bs.backgroundColor !== cs.backgroundColor,
            // 카드 상단(테두리 안쪽)까지 밴드가 닿는가.
            topOffset: Math.round(eb.top - cb.top),
            // 좌측 accent border 안쪽부터 카드 우측 끝까지 채우는가.
            leftInset: Math.round(eb.left - cb.left),
            rightInset: Math.round(cb.right - eb.right),
            borderBottom: Math.round(parseFloat(bs.borderBottomWidth) || 0),
            // 밴드 내부 첫 탭의 위치(적용 전과 동일해야 함 = 카드 상단 + 48/52px).
            firstTabTop: (() => {
              const t = el.querySelector("button");
              return t ? Math.round(t.getBoundingClientRect().top - cb.top) : null;
            })(),
          };
        })(),
        // 제목 앞 accent 도트(size-2.5 = 10px 원).
        titleDot: !!title && !!title.querySelector('span[aria-hidden="true"].rounded-full'),
        width: Math.round(card.getBoundingClientRect().width),
      };
    });
  });
}

const findCard = (cards, name) => cards.find((c) => (c.title ?? "").startsWith(name)) ?? null;

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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 }); break; }
    catch (e) { if (attempt >= 12) throw e; await page.waitForTimeout(5000); }
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

const ORG = process.env.SMOKE_ORG ?? "encre";
const BASE_PATH = "/admin/integrated/line-opening";
// [라벨, URL, '라인 개설' 영역 카드 제목들, 헤더 없는 카드 개수]
const TARGETS = [
  ["실무 정보", `${BASE_PATH}/practical-info?tab=open&org=${ORG}`, ["라인 개설"]],
  ["실무 경험", `${BASE_PATH}/practical-experience?tab=open&org=${ORG}`, []],
  ["실무 역량", `${BASE_PATH}/practical-competency?tab=open&org=${ORG}`, ["라인 개설", "해당 크루"]],
];

try {
  const light = {};
  for (const [label, url, openCardTitles] of TARGETS) {
    console.log(`\n[라이트] ${label} ${url}`);
    const cards = await load(url);
    check("카드 렌더됨", cards.length > 0, `${cards.length}개`);

    // ① 상태창 / 로그창
    assertAccentCard("상태창", findCard(cards, "상태창"));
    assertAccentCard("로그창", findCard(cards, "로그창"));

    // ② 라인 개설 카드
    for (const t of openCardTitles) assertAccentCard(`'${t}' 카드`, findCard(cards, t));

    // 실무 경험의 라인 개설 보드는 CardHeader(제목)가 없는 입력 카드 — accent/외곽선만 검증.
    if (label === "실무 경험") {
      const headerless = cards.filter((c) => !c.hasHeader);
      check("제목 없는 라인 개설 보드 존재", headerless.length >= 1, `${headerless.length}개`);
      for (const c of headerless) {
        check("라인 개설 보드 · 좌측 accent 4px",
          c.leftBorderWidth === 4 && !c.leftBorderTransparent, `${c.leftBorderWidth}px ${c.leftBorderColor}`);
        check("라인 개설 보드 · 외곽선 강화", c.shadowLayers >= 2, c.boxShadow.slice(0, 70));
        // 제목이 없으므로 첫 줄(팀 탭)이 헤더 밴드 — 카드 상단·좌우 끝까지 틴트가 차되 탭 위치는 불변.
        check("라인 개설 보드 · 헤더 밴드 틴트", !!c.band?.tinted, c.band ? "" : "탭 바 없음");
        check("라인 개설 보드 · 밴드가 카드 상단/좌우 끝까지",
          c.band?.topOffset === 0 && c.band?.leftInset === 4 && c.band?.rightInset === 0,
          `top ${c.band?.topOffset} / left ${c.band?.leftInset} / right ${c.band?.rightInset}`);
        check("라인 개설 보드 · 밴드 하단 경계선", (c.band?.borderBottom ?? 0) >= 1);
        // 1440px(md) 기준 카드 py-7(28) + CardContent pt-6(24) = 52px — 음수 마진 상쇄 후에도 동일.
        check("라인 개설 보드 · 탭 위치 불변(카드 상단 +52px)", c.band?.firstTabTop === 52,
          `${c.band?.firstTabTop}px`);
      }
    }

    // 카드 폭/개수 스냅샷 — 다크 모드 비교용(레이아웃 무변경 확인).
    light[url] = JSON.stringify(cards.map((c) => [c.title, c.width]));
  }

  // ── 다크 모드 ──
  for (const [label, url, openCardTitles] of TARGETS) {
    console.log(`\n[다크] ${label}`);
    await load(url);
    await setTheme("dark");
    const cards = await readCards(page);
    assertAccentCard("상태창(다크)", findCard(cards, "상태창"));
    assertAccentCard("로그창(다크)", findCard(cards, "로그창"));
    for (const t of openCardTitles) assertAccentCard(`'${t}' 카드(다크)`, findCard(cards, t));
    check("다크에서 카드 개수·폭 동일(레이아웃 무변경)",
      JSON.stringify(cards.map((c) => [c.title, c.width])) === light[url]);
    await setTheme("light");
  }

  // ── 회귀: 라인 개설 화면 밖 카드에는 영향 없음 ──
  console.log("\n[회귀] 다른 어드민 화면 카드 — accent/틴트 미적용 유지");
  for (const url of [
    "/admin/periods/register",
    "/admin/settings/line-opening-windows",
    `${BASE_PATH}/practical-competency?org=${ORG}`, // [라인 관리] 탭(기본)
  ]) {
    const cards = await load(url);
    const accented = cards.filter((c) => c.leftBorderWidth === 4 && !c.leftBorderTransparent);
    // 라인 관리 탭의 팀 카드(ExperienceLineManageBoard/CompetencyLineManageBoard)는 원래부터
    // accent 를 갖는 기존 디자인 — 제목이 '… 팀' 인 카드만 예외로 허용한다.
    const unexpected = accented.filter((c) => !/팀$/.test(c.title ?? ""));
    check(`${url}: 신규 accent 유출 0`, unexpected.length === 0,
      unexpected.map((c) => c.title).join(" | ") || `카드 ${cards.length}개`);
    const tinted = cards.filter((c) => c.headerTinted && !/팀$/.test(c.title ?? ""));
    check(`${url}: 신규 헤더 틴트 유출 0`, tinted.length === 0,
      tinted.map((c) => c.title).join(" | ") || "-");
  }
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
