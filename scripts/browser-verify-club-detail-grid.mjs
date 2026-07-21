/**
 * 브라우저 UI 검증 — 클럽 상세 '현재 시점 현황' 반응형 4열 그리드.
 *   데스크톱 4열 / 태블릿 2열 / 모바일 1열 · 9개 셀 · 숫자·도움말 버튼 미숨김(overflow visible).
 *   ⚠ 레이아웃/타이포만 검증(데이터 로직·DTO·집계·도움말 key·data-* 선택자 무변경).
 *   ⚠ 이 어드민은 사이드바 고정(모바일 드로어 없음) → 대략 500px 미만에서는 콘텐츠가 가로로 넘칠 수
 *     있는 기존 특성이 있다(내용이 잘리는 것이 아니라 시각적으로 넘침). 여기서는 "열 수 + 숨김 없음"만 본다.
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-club-detail-grid.mjs  (READ-ONLY)
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
let chromium;
try { ({ chromium } = rq("playwright-core")); } catch { ({ chromium } = rq("playwright")); }
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function cookies() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin 세션: ${email}`);
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

// 항목 순서(요구): 운영진·팀장 수·앰배서더·클러빙 / 정규·심화·파트 수·파트장 / 에이전트 수
const ORDER = ["staffCount","teamLeaderCount","ambassadorCount","clubbingCount","regularCrewCount","advancedCrewCount","partCount","partLeaderCount","agentCount"];
const WIDTHS = { desktop: [1440, 4], tablet: [800, 2], mobile: [430, 1] };

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ck0 = await cookies();
  for (const [name, [w, expectCols]] of Object.entries(WIDTHS)) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 1000 } });
    await ctx.addCookies(ck0);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/team-parts/info/encre`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-club-current-summary="encre"]', { timeout: 25000 }).catch(() => {});
    await page.waitForFunction(
      () => { const c = document.querySelector('[data-club-current-cell="staffCount"] strong'); return c && c.textContent.trim() !== "–"; },
      { timeout: 25000 },
    ).catch(() => {});
    await page.waitForTimeout(300);

    const info = await page.$eval('[data-club-current-summary="encre"]', (root, order) => {
      const grid = root.querySelector(".grid");
      const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
      const cells = [...grid.querySelectorAll("[data-club-current-cell]")];
      const keys = cells.map((c) => c.getAttribute("data-club-current-cell"));
      let helpOk = 0, numOk = 0, bulletOk = 0;
      for (const c of cells) {
        if (c.querySelector("button,[role='button'],svg")) helpOk++;
        const strong = c.querySelector("strong");
        if (strong && strong.textContent.trim() !== "" && strong.textContent.trim() !== "–") numOk++;
        if ((c.textContent || "").trim().startsWith("·")) bulletOk++;
      }
      const overflowHidden = [root, grid, ...cells].some((e) => {
        const ox = getComputedStyle(e).overflowX;
        return ox === "hidden" || ox === "clip";
      });
      const orderOk = JSON.stringify(keys) === JSON.stringify(order);
      return { cols, count: cells.length, helpOk, numOk, bulletOk, overflowHidden, orderOk, keys };
    }, ORDER);

    console.log(`\n[${name} ${w}px]`);
    ck(`grid ${expectCols}열`, info.cols === expectCols, `cols=${info.cols}`);
    ck("9개 셀 · 순서 유지", info.count === 9 && info.orderOk, JSON.stringify(info.keys));
    ck("모든 셀 숫자 표시", info.numOk === 9, `numOk=${info.numOk}`);
    ck("모든 셀 도움말 버튼 유지", info.helpOk === 9, `helpOk=${info.helpOk}`);
    ck("모든 셀 · 불렛 유지", info.bulletOk === 9, `bulletOk=${info.bulletOk}`);
    ck("숨김(overflow hidden/clip) 없음", info.overflowHidden === false);
    await ctx.close();
  }
  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
