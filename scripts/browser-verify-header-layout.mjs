// 브라우저 검증 — 헤더 레이아웃(자동 로그아웃 카운트다운 추가 후 정렬).
//   · 헤더 높이가 4행 사용자 정보를 담고 로그아웃 버튼/카운트다운이 잘리지 않는지
//   · 로그아웃 버튼이 헤더 박스 안에 완전히 들어오는지(위쪽 잘림 없음)
//   · 카운트다운이 헤더 안에 있고 하단 border 와 겹치지/붙지 않는지
//   · 사이드바 HOME 영역 높이 == 헤더 높이(상단 바 정렬)
//   · 긴 이름/이메일 + 좁은 뷰포트에서도 가로 오버플로 없이 유지
// 실행: node scripts/browser-verify-header-layout.mjs
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
  const { data: verifyData } = await browser.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// 헤더/버튼/카운트다운/사이드바 HOME 의 경계 사각형을 읽는다.
async function measure(page) {
  return page.evaluate(() => {
    const header = document.querySelector("header");
    const btn = Array.from(document.querySelectorAll("header button")).find((b) => /로그아웃/.test(b.textContent || ""));
    const cd = document.querySelector('[data-testid="admin-session-countdown"]');
    const emailSpan = header?.querySelector("span.truncate");
    // 사이드바 HOME 컨테이너 = HOME 링크 조상 중 헤더와 비슷한 높이(>=80px)인 박스
    const homeLink = document.querySelector('a[href="/admin"]');
    let homeBox = homeLink?.parentElement ?? null;
    while (homeBox && homeBox.getBoundingClientRect().height < 80) {
      homeBox = homeBox.parentElement;
    }
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const rect = (x) => (x ? { top: x.top, bottom: x.bottom, left: x.left, right: x.right, height: x.height, width: x.width } : null);
    return {
      header: rect(r(header)),
      btn: rect(r(btn)),
      cd: rect(r(cd)),
      home: rect(r(homeBox)),
      emailSpan: emailSpan ? { scrollW: emailSpan.scrollWidth, clientW: emailSpan.clientWidth } : null,
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    };
  });
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies(await makeAdminCookies());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  // ── 기본(1280px) ──
  console.log("\n[1] 기본 뷰포트(1280)");
  let m = await measure(page);
  check("헤더 높이 = 128px(h-32)", Math.abs(m.header.height - 128) <= 1, `${m.header.height}px`);
  check("로그아웃 버튼이 헤더 박스 안에 완전 포함(위/아래 안 잘림)",
    m.btn && m.btn.top >= m.header.top - 0.5 && m.btn.bottom <= m.header.bottom + 0.5,
    `btn[${m.btn.top.toFixed(1)}~${m.btn.bottom.toFixed(1)}] header[${m.header.top.toFixed(1)}~${m.header.bottom.toFixed(1)}]`);
  check("카운트다운이 헤더 안에 위치", m.cd && m.cd.top >= m.header.top && m.cd.bottom <= m.header.bottom,
    `cd.bottom=${m.cd.bottom.toFixed(1)} header.bottom=${m.header.bottom.toFixed(1)}`);
  check("카운트다운과 하단 border 간격 >= 6px(겹침/밀착 아님)",
    m.cd && (m.header.bottom - m.cd.bottom) >= 6, `gap=${(m.header.bottom - m.cd.bottom).toFixed(1)}px`);
  check("사이드바 HOME 높이 == 헤더 높이(상단 바 정렬)",
    m.home && Math.abs(m.home.height - m.header.height) <= 1, `home=${m.home?.height} header=${m.header.height}`);
  check("가로 오버플로 없음", m.docScrollW <= m.innerW + 1, `scrollW=${m.docScrollW} inner=${m.innerW}`);

  // ── 긴 이름/이메일 주입 ──
  console.log("\n[2] 아주 긴 이름/이메일");
  await page.evaluate(() => {
    const span = document.querySelector("header span.truncate");
    if (span) span.textContent = "홍길동아주아주긴관리자이름님 | very.long.admin.email.address.for.layout.test@example-organization.co.kr";
  });
  await page.waitForTimeout(150);
  m = await measure(page);
  check("긴 텍스트에도 헤더 높이 유지(112px)", Math.abs(m.header.height - 128) <= 1, `${m.header.height}px`);
  check("이름/이메일 truncate 적용(말줄임)", m.emailSpan && m.emailSpan.scrollW > m.emailSpan.clientW,
    `scrollW=${m.emailSpan?.scrollW} clientW=${m.emailSpan?.clientW}`);
  check("긴 텍스트에도 가로 오버플로 없음", m.docScrollW <= m.innerW + 1, `scrollW=${m.docScrollW} inner=${m.innerW}`);
  check("로그아웃 버튼 여전히 헤더 안", m.btn && m.btn.top >= m.header.top - 0.5 && m.btn.bottom <= m.header.bottom + 0.5);

  // ── 현실적 반응형 폭(태블릿/작은 데스크톱) ──
  for (const w of [1024, 768]) {
    console.log(`\n[3] 반응형 뷰포트(${w}px)`);
    await page.setViewportSize({ width: w, height: 800 });
    await page.waitForTimeout(200);
    m = await measure(page);
    check("헤더 높이 유지(128px)", Math.abs(m.header.height - 128) <= 1, `${m.header.height}px`);
    check("가로 오버플로 없음", m.docScrollW <= m.innerW + 1, `scrollW=${m.docScrollW} inner=${m.innerW}`);
    check("카운트다운 헤더 안 + border 간격 유지",
      m.cd && m.cd.bottom <= m.header.bottom && (m.header.bottom - m.cd.bottom) >= 6,
      `gap=${(m.header.bottom - m.cd.bottom).toFixed(1)}px`);
    check("로그아웃 버튼 헤더 안(위 안 잘림)", m.btn && m.btn.top >= m.header.top - 0.5 && m.btn.bottom <= m.header.bottom + 0.5);
  }

  // ── 극단 모바일(390px): 카운트다운이 말줄임으로 줄어들어 가로 오버플로 없이 유지 ──
  console.log("\n[4] 극단 모바일(390px)");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(200);
  m = await measure(page);
  check("헤더 높이 유지(128px)", Math.abs(m.header.height - 128) <= 1, `${m.header.height}px`);
  check("가로 오버플로 없음(390px)", m.docScrollW <= m.innerW + 1, `scrollW=${m.docScrollW} inner=${m.innerW}`);
  check("카운트다운 헤더 안 + border 간격 유지",
    m.cd && m.cd.bottom <= m.header.bottom && (m.header.bottom - m.cd.bottom) >= 6,
    `gap=${(m.header.bottom - m.cd.bottom).toFixed(1)}px`);
  check("로그아웃 버튼 헤더 안(위 안 잘림)", m.btn && m.btn.top >= m.header.top - 0.5 && m.btn.bottom <= m.header.bottom + 0.5);

  // 스크린샷(육안 확인용)
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-header-layout.png"), clip: { x: 900, y: 0, width: 380, height: 130 } });

  await ctx.close();
  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
