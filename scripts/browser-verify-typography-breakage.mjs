// 2차 폰트 확대(+3pt) 이후 UI 깨짐 종합 감사.
//   · 지정 필수 페이지를 데스크톱(1440) + 좁은 화면(390)에서 순회.
//   · 측정: 페이지 가로 오버플로(body 스크롤), 버튼/배지/탭 텍스트 클리핑(scrollWidth>clientWidth),
//     드롭다운(select/[role=combobox]) 클리핑, 사이드바 링크 클리핑, 표 컨테이너 내부 스크롤 여부.
//   · 각 페이지 스크린샷을 claudedocs/qa-brk-*.png 로 남긴다.
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
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

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

let pass = 0, fail = 0, warn = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const note = (label, detail = "") => { console.log(`  · ${label}${detail ? ` — ${detail}` : ""}`); };

// 필수 검증 페이지(사용자 지정).
const PAGES = [
  ["대시보드", "/admin", "dash"],
  ["회원 관리(users)", "/admin/users?org=encre", "users"],
  ["프로세스(processes)", "/admin/processes?org=encre", "processes"],
  ["활동 관리(check)", "/admin/processes/check?org=encre", "check"],
  ["라인개설-경험", "/admin/line-opening/practical-experience?org=encre", "exp"],
  ["라인개설-역량", "/admin/line-opening/practical-competency?org=encre", "comp"],
  ["주차 카드 확정", "/admin/weekly-card-finalization?org=encre", "wcf"],
];

// 페이지 내부 레이아웃 깨짐 측정.
async function auditLayout() {
  return page.evaluate(() => {
    const clip = (el) => el.scrollWidth > el.clientWidth + 2; // 텍스트가 박스보다 넓음(잘림 후보)
    const sample = (sel) => Array.from(document.querySelectorAll(sel));

    // 1) 페이지 전체 가로 오버플로(가로 스크롤이 body 레벨에서 생기는지)
    const docOverflow = document.documentElement.scrollWidth - window.innerWidth;

    // 2) 버튼 텍스트 클리핑
    const buttons = sample("button");
    const clippedButtons = buttons.filter(clip);

    // 3) 배지 클리핑 + 세로정렬(라인하이트로 인한 넘침)
    const badges = sample('[data-slot="badge"], .badge, [class*="badge"]');
    const clippedBadges = badges.filter(clip);

    // 4) 탭 클리핑
    const tabs = sample('[role="tab"]');
    const clippedTabs = tabs.filter(clip);

    // 5) 드롭다운(native select + combobox 트리거)
    const selects = sample('select, [role="combobox"], [data-slot="select-trigger"]');
    const clippedSelects = selects.filter(clip);

    // 6) 사이드바 링크 클리핑
    const sideLinks = sample('[data-slot="sidebar"] a, nav a, aside a');
    const clippedSideLinks = sideLinks.filter(clip);

    // 7) 표 컨테이너: 오버플로 시 내부(컨테이너 div)에서 스크롤되는지(=body 로 안 넘침)
    const containers = sample('[data-slot="table-container"]');
    const scrollerOverflow = containers.map((c) => {
      const scroller = c.querySelector(":scope > div");
      if (!scroller) return { has: false };
      return { has: scroller.scrollWidth > scroller.clientWidth + 1 };
    });
    const overflowingTables = scrollerOverflow.filter((s) => s.has).length;

    // 8) 뷰포트 밖으로 삐져나온 넓은 요소(우측 경계 초과, 표 스크롤러 제외)
    const vw = window.innerWidth;
    const bleeders = sample("main *").filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // 표 스크롤러/그 내부는 의도된 내부 스크롤이므로 제외
      if (el.closest('[data-slot="table-container"]')) return false;
      return r.right > vw + 2;
    }).length;

    const short = (el) => (el.innerText || el.value || "").trim().slice(0, 24).replace(/\s+/g, " ");
    return {
      docOverflow,
      buttons: buttons.length, clippedButtons: clippedButtons.length, clippedButtonSamples: clippedButtons.slice(0, 4).map(short),
      badges: badges.length, clippedBadges: clippedBadges.length, clippedBadgeSamples: clippedBadges.slice(0, 4).map(short),
      tabs: tabs.length, clippedTabs: clippedTabs.length,
      selects: selects.length, clippedSelects: clippedSelects.length, clippedSelectSamples: clippedSelects.slice(0, 4).map(short),
      sideLinks: sideLinks.length, clippedSideLinks: clippedSideLinks.length,
      containers: containers.length, overflowingTables,
      bleeders,
    };
  });
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120)); });

async function visit(url) {
  try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 }); }
  catch { await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 30000 }); }
  await page.waitForTimeout(1400);
}

try {
  for (const [label, url, slug] of PAGES) {
    console.log(`\n[${label}] ${url}`);
    // ── 데스크톱 1440 ──
    await page.setViewportSize({ width: 1440, height: 900 });
    await visit(url);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-brk-${slug}-1440.png`), fullPage: false });
    const d = await auditLayout();
    note(`btn ${d.buttons}(clip ${d.clippedButtons}) · badge ${d.badges}(clip ${d.clippedBadges}) · tab ${d.tabs}(clip ${d.clippedTabs}) · sel ${d.selects}(clip ${d.clippedSelects}) · side ${d.sideLinks}(clip ${d.clippedSideLinks}) · tblCont ${d.containers}(overflow ${d.overflowingTables})`);
    check("[1440] 페이지 가로 오버플로 없음", d.docOverflow <= 2, `docOverflow=${d.docOverflow}px`);
    check("[1440] 버튼 텍스트 클리핑 없음", d.clippedButtons === 0, d.clippedButtonSamples.join(" | "));
    check("[1440] 배지 클리핑 없음", d.clippedBadges === 0, d.clippedBadgeSamples.join(" | "));
    check("[1440] 드롭다운 클리핑 없음", d.clippedSelects === 0, d.clippedSelectSamples.join(" | "));
    check("[1440] 탭 클리핑 없음", d.clippedTabs === 0);
    check("[1440] 사이드바 링크 클리핑 없음", d.clippedSideLinks === 0);
    check("[1440] main 밖으로 삐져나온 요소 없음(표 제외)", d.bleeders === 0, `bleeders=${d.bleeders}`);

    // ── 좁은 화면 390 (모바일) ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const m = await auditLayout();
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-brk-${slug}-390.png`), fullPage: false });
    // 좁은 화면에선 표는 가로 스크롤 허용. 단, 표 컨테이너 밖 요소가 body 를 밀면 안 됨.
    note(`[390] docOverflow=${m.docOverflow}px · bleeders(비표)=${m.bleeders} · btnClip=${m.clippedButtons} · badgeClip=${m.clippedBadges}`);
    // 모바일 body 가로 오버플로는 "표 외" 요소가 원인일 때만 실패로 본다.
    check("[390] 표 외 요소가 가로로 넘치지 않음", m.bleeders === 0, `bleeders=${m.bleeders}`);
  }

  console.log(`\n콘솔 에러(${consoleErrors.length}):`, consoleErrors.slice(0, 6).join(" || ") || "없음");
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
