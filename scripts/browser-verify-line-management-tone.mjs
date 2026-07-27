// 브라우저(인증 세션) 검증 — /admin/(integrated/)line-opening/* [라인 관리] 탭 가시성 개선.
//
// 검증 대상(기본 탭 = tab 파라미터 없음):
//   · 실무 정보(practical-info)   — "주차별 개설 결과" 요약 통계 5종 + 라인별 개설 카드
//   · 실무 역량(practical-competency) — 집계 카드 6종 + 크루별 결과 배지
//
// 공통 디자인 계약(components/admin/lineManagementTone.tsx):
//   · 요약 통계 박스는 항목마다 서로 다른 파스텔 배경 — 전부 같은 색(bg-muted)이면 실패
//   · 숫자는 라벨보다 굵고(fontWeight ↑) 진하다(대비 ↑)
//   · 라인 카드는 상태별로 배경/테두리가 다르다 — 미오픈 카드도 opacity 로 죽지 않는다
//   · 라이트/다크 모두 텍스트 대비 확보(WCAG AA 본문 4.5:1 근처)
// 회귀 방지:
//   · 통합 경로와 원본 경로가 동일 DOM(카드 순서·라인명·상태 문구 동일)
//   · operating(기본)과 mode=test 의 DOM 구조(라벨/클래스 조합)가 동일
//   · CardTitle·버튼·도움말 버튼 개수 불변
//
// 사용법: node scripts/browser-verify-line-management-tone.mjs
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

// ── 색 유틸: 대비비(WCAG) 계산 ──────────────────────────────────────────────
const parseRgb = (s) => {
  const m = String(s).match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x.trim()));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
};
const over = (fg, bg) => {
  // 반투명 전경/배경을 불투명 배경 위에 합성.
  if (!fg) return bg;
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
};
const lum = (c) => {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const contrast = (fgStr, bgStr, pageBgStr) => {
  const page = parseRgb(pageBgStr) ?? { r: 255, g: 255, b: 255, a: 1 };
  const bg = over(parseRgb(bgStr), page);
  const fg = over(parseRgb(fgStr), bg);
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

// getComputedStyle 이 Tailwind v4 의 oklch 계열을 `oklab(...)`/`lab(...)` 로 돌려주므로,
//   페이지 안에서 1x1 캔버스에 칠해 sRGB rgba 로 정규화한 뒤 Node 로 넘긴다(대비 계산 가능하게).
//   ⚠ 각 evaluate 는 독립 스코프라 이 헬퍼를 페이지에 주입해 두고 window.__rgba 로 공유한다.
async function installRgba(page) {
  await page.evaluate(() => {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    window.__rgba = (color) => {
      if (!color) return "rgba(0, 0, 0, 0)";
      ctx.fillStyle = "#000";
      try { ctx.fillStyle = color; } catch { return "rgba(0, 0, 0, 0)"; }
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${d[3] / 255})`;
    };
  });
}

// ── 페이지에서 [라인 관리] 탭의 tone 관련 계산값 추출 ───────────────────────
async function readInfo(page) {
  return page.evaluate(() => {
    const rgba = window.__rgba;
    const txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("main") ?? document.body;
    const card = Array.from(root.querySelectorAll('[data-slot="card"]')).find((c) =>
      txt(c.querySelector('[data-slot="card-title"]')).startsWith("주차별 개설 결과"),
    );
    if (!card) return null;
    const content = card.querySelector('[data-slot="card-content"]');
    // 라이트/다크 모두에서 '실제로 뒤에 깔린 불투명 색' — body 가 투명하면 <html> 로 폴백.
    const bodyBg = rgba(getComputedStyle(document.body).backgroundColor);
    const pageBg = bodyBg.endsWith(", 0)")
      ? rgba(getComputedStyle(document.documentElement).backgroundColor)
      : bodyBg;

    // 요약 통계 박스 = CardContent 직계의 flex-wrap 컨테이너의 자식들.
    const summaryWrap = content?.querySelector(":scope > div.flex.flex-wrap");
    const summaries = Array.from(summaryWrap?.children ?? []).map((box) => {
      const cs = getComputedStyle(box);
      const spans = box.querySelectorAll(":scope > span");
      const labelEl = spans[0], valueEl = spans[1];
      const ls = labelEl ? getComputedStyle(labelEl) : null;
      const vs = valueEl ? getComputedStyle(valueEl) : null;
      return {
        label: txt(labelEl),
        value: txt(valueEl),
        bg: rgba(cs.backgroundColor),
        border: rgba(cs.borderTopColor),
        labelColor: ls ? rgba(ls.color) : null,
        labelWeight: ls ? parseInt(ls.fontWeight, 10) : null,
        valueColor: vs ? rgba(vs.color) : null,
        valueWeight: vs ? parseInt(vs.fontWeight, 10) : null,
        valueTabular: vs ? vs.fontVariantNumeric.includes("tabular-nums") : false,
        pageBg,
      };
    });

    // 라인별 개설 카드 = grid 컨테이너의 자식들.
    const grid = content?.querySelector(":scope > div.grid");
    const cards = Array.from(grid?.children ?? []).map((el) => {
      const cs = getComputedStyle(el);
      const badge = el.querySelector("span.rounded-full");
      const bs = badge ? getComputedStyle(badge) : null;
      const nameEl = el.querySelector(":scope > div > span");
      const ns = nameEl ? getComputedStyle(nameEl) : null;
      const dds = Array.from(el.querySelectorAll("dd")).map((d) => {
        const s = getComputedStyle(d);
        return {
          text: txt(d),
          weight: parseInt(s.fontWeight, 10),
          tabular: s.fontVariantNumeric.includes("tabular-nums"),
        };
      });
      const dts = Array.from(el.querySelectorAll("dt")).map((d) => txt(d));
      return {
        lineName: txt(nameEl),
        lineNameWeight: ns ? parseInt(ns.fontWeight, 10) : null,
        status: txt(badge),
        bg: rgba(cs.backgroundColor),
        border: rgba(cs.borderTopColor),
        opacity: parseFloat(cs.opacity),
        badgeBg: bs ? rgba(bs.backgroundColor) : null,
        badgeColor: bs ? rgba(bs.color) : null,
        badgeBorder: bs ? rgba(bs.borderTopColor) : null,
        buttons: el.querySelectorAll("button").length,
        dts,
        dds,
        pageBg,
      };
    });

    return {
      summaries,
      cards,
      titles: Array.from(root.querySelectorAll('[data-slot="card-title"]')).map(txt),
      helpButtons: root.querySelectorAll('button[aria-label*="도움말"], button[title]').length,
    };
  });
}

async function readCompetency(page) {
  return page.evaluate(() => {
    const rgba = window.__rgba;
    const txt = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const root = document.querySelector("main") ?? document.body;
    const bodyBg = rgba(getComputedStyle(document.body).backgroundColor);
    const pageBg = bodyBg.endsWith(", 0)")
      ? rgba(getComputedStyle(document.documentElement).backgroundColor)
      : bodyBg;
    // 집계 카드 = "min-width:78px + text-align:center" 인 박스.
    const stats = Array.from(root.querySelectorAll("div")).filter((d) => {
      const cs = getComputedStyle(d);
      return cs.textAlign === "center" && Math.round(parseFloat(cs.minWidth) || 0) === 78;
    }).map((box) => {
      const cs = getComputedStyle(box);
      const ps = box.querySelectorAll("p");
      const vs = ps[0] ? getComputedStyle(ps[0]) : null;
      const ls = ps[1] ? getComputedStyle(ps[1]) : null;
      return {
        value: txt(ps[0]),
        label: txt(ps[1]),
        bg: rgba(cs.backgroundColor),
        border: rgba(cs.borderTopColor),
        valueColor: vs ? rgba(vs.color) : null,
        valueWeight: vs ? parseInt(vs.fontWeight, 10) : null,
        valueTabular: vs ? vs.fontVariantNumeric.includes("tabular-nums") : false,
        labelColor: ls ? rgba(ls.color) : null,
        labelWeight: ls ? parseInt(ls.fontWeight, 10) : null,
        pageBg,
      };
    });
    // 결과 배지(강화 성공/실패) — 표 안 rounded-full.
    const badges = Array.from(root.querySelectorAll("table span.rounded-full")).map((b) => {
      const cs = getComputedStyle(b);
      return { text: txt(b), bg: rgba(cs.backgroundColor), color: rgba(cs.color), border: rgba(cs.borderTopColor), pageBg };
    });
    return {
      stats,
      badges,
      rowCount: root.querySelectorAll("table tbody tr").length,
    };
  });
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const load = async (url) => {
  for (let attempt = 0; ; attempt++) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 60000 }); break; }
    catch (e) { if (attempt >= 12) throw e; await page.waitForTimeout(5000); }
  }
  await page.waitForTimeout(1800);
  await installRgba(page);
};

const setTheme = async (theme) => {
  await page.evaluate((t) => {
    const root = document.documentElement;
    if (t === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
    try { window.localStorage.setItem("vraxium-theme", t); } catch {}
  }, theme);
  await page.waitForTimeout(500);
};

const INFO_EXPECTED = ["전체 라인", "오픈 라인", "개설 라인", "개설 필요", "미오픈"];
const ORGS = (process.env.SMOKE_ORGS ?? "encre,phalanx").split(",");

function assertInfo(label, data, theme) {
  if (!data) return check(`${label} · "주차별 개설 결과" 카드`, false, "카드를 찾지 못함");
  // ① 요약 통계 5종 + 순서/문구 불변
  check(`${label} · 요약 통계 5종·문구·순서 불변`,
    data.summaries.length === 5 && data.summaries.every((s, i) => s.label.startsWith(INFO_EXPECTED[i])),
    data.summaries.map((s) => `${s.label}=${s.value}`).join(" | "));
  // ② 서로 다른 파스텔 배경(전부 같은 bg-muted 이면 실패)
  const bgs = new Set(data.summaries.map((s) => s.bg));
  check(`${label} · 통계 박스 배경 5종 모두 상이`, bgs.size === 5, [...bgs].join(" "));
  const borders = new Set(data.summaries.map((s) => s.border));
  check(`${label} · 통계 박스 테두리 5종 모두 상이`, borders.size === 5, [...borders].join(" "));
  // ③ 숫자가 라벨보다 굵고 진함 + tabular-nums
  for (const s of data.summaries) {
    const okWeight = s.valueWeight > s.labelWeight;
    const cL = contrast(s.labelColor, s.bg, s.pageBg);
    const cV = contrast(s.valueColor, s.bg, s.pageBg);
    check(`${label} · [${s.label}] 숫자 강조(굵기 ${s.labelWeight}→${s.valueWeight}, 대비 ${cL.toFixed(1)}→${cV.toFixed(1)})`,
      okWeight && cV > cL);
    check(`${label} · [${s.label}] 라벨 대비 AA(${cL.toFixed(2)})`, cL >= 4.0);
    check(`${label} · [${s.label}] 숫자 tabular-nums`, s.valueTabular);
  }
  // ④ 라인 카드 — 상태별 배경/테두리 구분, opacity 로 죽이지 않음
  check(`${label} · 라인 카드 존재`, data.cards.length > 0, `${data.cards.length}개`);
  const byStatus = new Map();
  for (const c of data.cards) {
    if (!byStatus.has(c.status)) byStatus.set(c.status, c);
    check(`${label} · [${c.lineName}] opacity 미사용(${c.opacity})`, c.opacity === 1);
    check(`${label} · [${c.lineName}] 라인명 semibold`, c.lineNameWeight >= 600);
    const cb = contrast(c.badgeColor, c.badgeBg, c.pageBg);
    check(`${label} · [${c.lineName}] 배지 "${c.status}" 대비 ${cb.toFixed(2)}`, cb >= 4.0);
  }
  const statusBgs = new Set([...byStatus.values()].map((c) => c.bg));
  check(`${label} · 상태별 카드 배경 상이(${[...byStatus.keys()].join("/")})`,
    statusBgs.size === byStatus.size, [...statusBgs].join(" "));
  const statusBadgeBgs = new Set([...byStatus.values()].map((c) => c.badgeBg));
  check(`${label} · 상태별 배지 배경 상이`, statusBadgeBgs.size === byStatus.size);
  // ⑤ 개설 완료 카드 내부 위계 — 라벨/값/숫자
  const opened = data.cards.find((c) => c.status === "개설 완료");
  if (opened) {
    check(`${label} · 개설 완료 필드 라벨 5종 불변`,
      JSON.stringify(opened.dts) === JSON.stringify(["개설 시점", "메인 타이틀", "개설자", "개설 해당자", "2차 기입자"]),
      opened.dts.join("/"));
    check(`${label} · 개설 시점 tabular-nums`, opened.dds[0]?.tabular === true);
    check(`${label} · 인원 숫자 semibold+tabular`,
      opened.dds[3]?.weight >= 600 && opened.dds[3]?.tabular &&
      opened.dds[4]?.weight >= 600 && opened.dds[4]?.tabular);
  }
  if (theme) check(`${label} · 테마=${theme}`, true);
}

function assertCompetency(label, data) {
  check(`${label} · 집계 카드 6종`, data.stats.length === 6,
    data.stats.map((s) => `${s.label}=${s.value}`).join(" | "));
  if (data.stats.length !== 6) return;
  // 의미가 다른 tone 은 배경이 달라야 한다(neutral/info/success/danger 4종 → 배경 4종).
  const bgs = new Set(data.stats.map((s) => s.bg));
  check(`${label} · 집계 tone 배경 4종(neutral/info/success/danger)`, bgs.size === 4, [...bgs].join(" "));
  for (const s of data.stats) {
    const cV = contrast(s.valueColor, s.bg, s.pageBg);
    const cL = contrast(s.labelColor, s.bg, s.pageBg);
    check(`${label} · [${s.label}] 숫자 강조(대비 ${cL.toFixed(1)}→${cV.toFixed(1)})`,
      s.valueWeight > s.labelWeight && cV > cL);
    check(`${label} · [${s.label}] 라벨 대비 AA(${cL.toFixed(2)})`, cL >= 4.0);
    check(`${label} · [${s.label}] 숫자 tabular-nums`, s.valueTabular);
  }
  if (data.badges.length > 0) {
    for (const b of new Map(data.badges.map((x) => [x.text, x])).values()) {
      const c = contrast(b.color, b.bg, b.pageBg);
      check(`${label} · 결과 배지 "${b.text}" 대비 ${c.toFixed(2)}`, c >= 4.0);
    }
  }
}

// DOM 동일성 비교용 지문 — 라벨/값/상태/순서만(색은 제외).
const infoFingerprint = (d) => JSON.stringify({
  s: d?.summaries.map((x) => [x.label, x.value]),
  c: d?.cards.map((x) => [x.lineName, x.status, x.dts, x.dds.map((y) => y.text), x.buttons]),
  t: d?.titles,
});
const compFingerprint = (d) => JSON.stringify({
  s: d.stats.map((x) => [x.label, x.value]),
  r: d.rowCount,
});

try {
  for (const ORG of ORGS) {
    for (const prefix of ["/admin/integrated/line-opening", "/admin/line-opening"]) {
      const tag = prefix.includes("integrated") ? "통합" : "원본";

      // ── 실무 정보 ──
      console.log(`\n[${tag}/${ORG}] 실무 정보 ${prefix}/practical-info?org=${ORG}`);
      await load(`${prefix}/practical-info?org=${ORG}`);
      const infoLight = await readInfo(page);
      assertInfo(`정보(${tag}/${ORG}/라이트)`, infoLight);
      await setTheme("dark");
      const infoDark = await readInfo(page);
      assertInfo(`정보(${tag}/${ORG}/다크)`, infoDark, "dark");
      check(`정보(${tag}/${ORG}) 라이트=다크 DOM 동일`, infoFingerprint(infoLight) === infoFingerprint(infoDark));
      await setTheme("light");

      console.log(`\n[${tag}/${ORG}] 실무 정보 mode=test`);
      await load(`${prefix}/practical-info?org=${ORG}&mode=test`);
      const infoTest = await readInfo(page);
      assertInfo(`정보(${tag}/${ORG}/test)`, infoTest);
      if (infoTest && infoLight) {
        // 데이터는 다를 수 있으나 라벨 세트/필드 구조는 동일해야 한다.
        check(`정보(${tag}/${ORG}) test DOM 구조 동일(통계 라벨)`,
          JSON.stringify(infoTest.summaries.map((s) => s.label)) ===
          JSON.stringify(infoLight.summaries.map((s) => s.label)));
        check(`정보(${tag}/${ORG}) test 통계 배경 = operating 배경`,
          JSON.stringify(infoTest.summaries.map((s) => s.bg)) ===
          JSON.stringify(infoLight.summaries.map((s) => s.bg)));
      }

      // ── 실무 역량 ──
      console.log(`\n[${tag}/${ORG}] 실무 역량 ${prefix}/practical-competency?org=${ORG}`);
      await load(`${prefix}/practical-competency?org=${ORG}`);
      const compLight = await readCompetency(page);
      assertCompetency(`역량(${tag}/${ORG}/라이트)`, compLight);
      await setTheme("dark");
      const compDark = await readCompetency(page);
      assertCompetency(`역량(${tag}/${ORG}/다크)`, compDark);
      check(`역량(${tag}/${ORG}) 라이트=다크 DOM 동일`, compFingerprint(compLight) === compFingerprint(compDark));
      await setTheme("light");

      console.log(`\n[${tag}/${ORG}] 실무 역량 mode=test`);
      await load(`${prefix}/practical-competency?org=${ORG}&mode=test`);
      const compTest = await readCompetency(page);
      assertCompetency(`역량(${tag}/${ORG}/test)`, compTest);
      check(`역량(${tag}/${ORG}) test 집계 라벨/배경 = operating`,
        JSON.stringify(compTest.stats.map((s) => [s.label, s.bg])) ===
        JSON.stringify(compLight.stats.map((s) => [s.label, s.bg])));
    }
  }

  // ── 통합/원본 경로 동일 컴포넌트 확인 ──
  console.log("\n[회귀] 통합 경로 = 원본 경로 DOM 동일");
  for (const ORG of ORGS) {
    await load(`/admin/integrated/line-opening/practical-info?org=${ORG}`);
    const a = infoFingerprint(await readInfo(page));
    await load(`/admin/line-opening/practical-info?org=${ORG}`);
    const b = infoFingerprint(await readInfo(page));
    check(`정보(${ORG}) 통합=원본`, a === b);

    await load(`/admin/integrated/line-opening/practical-competency?org=${ORG}`);
    const c = compFingerprint(await readCompetency(page));
    await load(`/admin/line-opening/practical-competency?org=${ORG}`);
    const d = compFingerprint(await readCompetency(page));
    check(`역량(${ORG}) 통합=원본`, c === d);
  }
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
