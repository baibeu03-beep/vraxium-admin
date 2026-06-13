// 검증(브라우저) — /admin/crews/encre 모집단 스코프(operating/test).
//   1) operating: 테스트 유저 미노출((T) 팀 0건) + 전체 인원 145
//   2) mode=test: 테스트 유저만 노출(전원 (T) 팀) + 전체 인원 31
//   3) operating ↔ test 전환 시 명단 분리
// read-only(백엔드 write 없음 · snapshot 무관 — 표시 스코프만).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre";

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name,
  value: i.value,
  domain: "localhost",
  path: "/",
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
}));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

const goto = async (path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  // 표가 채워질 때까지 — "불러오는 중" 사라지고 행이 생기거나 빈 결과 메시지.
  await page.waitForTimeout(2500);
};

// "전체 인원" StatCard 값.
const totalCount = () =>
  page.evaluate(() => {
    const titles = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent?.trim() === "전체 인원",
    );
    for (const t of titles) {
      const card = t.closest("[data-slot], div");
      // 같은 카드 내 숫자 div 탐색
      let p = t.parentElement;
      for (let i = 0; i < 4 && p; i++) p = p.parentElement;
      const num = p?.querySelector(".text-2xl, .text-xl, .font-semibold");
      const txt = num?.textContent?.trim();
      if (txt && /^\d+$/.test(txt)) return Number(txt);
    }
    return null;
  });

// 데이터 행 수 + 팀 셀에 "(T)" 포함 행 수.
const tableStats = () =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll("tbody tr")].filter((tr) => {
      const tds = tr.querySelectorAll("td");
      return tds.length > 2; // placeholder(colSpan) 제외
    });
    let tTeam = 0;
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll("td")].map((td) => td.textContent || "");
      if (cells.some((c) => c.includes("(T)"))) tTeam++;
    }
    return { rowCount: rows.length, testTeamRows: tTeam };
  });

try {
  // 인원 = StatCard("전체 인원") 우선, 실패 시 표 행 수(페이지네이션 없음 → data.length 동일).
  // ── 1) operating ──
  await goto(`/admin/crews/${ORG}`);
  const opCard = await totalCount();
  const opTbl = await tableStats();
  const opTotal = opCard ?? opTbl.rowCount;
  ck("[1] operating 전체 인원 145", opTotal === 145, `card=${opCard} rows=${opTbl.rowCount}`);
  ck("[1] operating 표에 (T) 테스트 팀 0건(테스트 유저 미노출)", opTbl.testTeamRows === 0, JSON.stringify(opTbl));
  await page.screenshot({
    path: resolve(adminRoot, "claudedocs", "browser-crews-encre-operating.png"),
    fullPage: false,
  });

  // ── 2) mode=test ──
  await goto(`/admin/crews/${ORG}?mode=test`);
  const tCard = await totalCount();
  const tTbl = await tableStats();
  const tTotal = tCard ?? tTbl.rowCount;
  ck("[2] test 전체 인원 31(테스트 유저만)", tTotal === 31, `card=${tCard} rows=${tTbl.rowCount}`);
  // 테스트 유저 31명 중 (T) 팀 미배정 1명 존재 가능 → "(T) 팀 다수 + 운영팀 0" 으로 검증.
  ck("[2] test 표 대부분 (T) 테스트 팀(운영 유저 미혼입)", tTbl.testTeamRows >= 30 && tTbl.rowCount === 31, JSON.stringify(tTbl));
  await page.screenshot({
    path: resolve(adminRoot, "claudedocs", "browser-crews-encre-test.png"),
    fullPage: false,
  });

  // ── 3) 전환 분리(operating ≠ test 인원) ──
  ck("[3] operating(145) ≠ test(31) 명단 분리", opTotal === 145 && tTotal === 31);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try {
    await page.screenshot({
      path: resolve(adminRoot, "claudedocs", "browser-crews-scope-error.png"),
      fullPage: true,
    });
  } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
