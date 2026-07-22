/**
 * 브라우저 렌더링 검증 — HTTP 응답이 아니라 **화면에 실제로 그려진 텍스트**가 현재 주차 override 를
 * 반영하는지 확인한다. HTTP 는 맞는데 화면만 옛 값인 경우(컴포넌트 상태/클라 계산)를 잡기 위함.
 *
 * 실제로 잡았던 사례: /admin/members 의 "클래스" 컬럼은 서버 statusLabel 이 아니라
 *   classLabel(m.role, m.membershipLevel) 로 **클라이언트에서** 만들고 있었다 → 서버를 고쳐도 화면 불변.
 *
 * 검증: /admin/members 크루 목록에서 대상 크루 행의 소속 파트·클래스 셀 텍스트 == override 값.
 *   READ-ONLY (DB 변경 없음). 사전조건: admin dev :3000 + override 행 존재.
 *   Usage: node scripts/browser-verify-week-position-render.mjs
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
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

const CODE_LABEL = { regular: "정규", advanced_agent: "심화(에이전트)", advanced_part_leader: "심화(파트장)" };
let fail = 0;
let observed = 0;
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

async function main() {
  const { data: ovr } = await sb.from("cluster4_team_week_position_overrides")
    .select("user_id,organization,raw_team,raw_part,position_code,week_start_date")
    .order("updated_at", { ascending: false }).limit(4);
  if (!ovr?.length) { console.log("override 없음 — abort"); process.exit(1); }
  const targets = [];
  for (const o of ovr) {
    const { data: p } = await sb.from("user_profiles")
      .select("display_name,role").eq("user_id", o.user_id).maybeSingle();
    const { data: m } = await sb.from("user_memberships")
      .select("membership_level").eq("user_id", o.user_id).eq("is_current", true).maybeSingle();
    // 멤버십 유도 클래스와 override 클래스가 다른 사람만 관측 유효.
    const derived = p?.role === "part_leader" || (m?.membership_level ?? "").startsWith("심화")
      ? (p?.role === "part_leader" ? "심화(파트장)" : "심화(에이전트)") : "정규";
    if (derived !== CODE_LABEL[o.position_code]) targets.push({ ...o, name: p?.display_name, derived });
  }
  if (targets.length === 0) { console.log("override==멤버십 인 행뿐 — 관측 불가. abort"); process.exit(1); }
  console.log(`관측 대상 ${targets.length}명 (override 클래스 ≠ 멤버십 유도 클래스)\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1900, height: 1200 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    const url = `${BASE}/admin/members?organization=${targets[0].organization}&mode=test`;
    console.log(`브라우저 이동: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // 크루 목록 탭 — 행이 그려질 때까지 대기.
    await page.waitForSelector("table tbody tr", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    // 헤더에서 "소속 파트"/"클래스" 컬럼 인덱스를 찾고, 대상 이름 행의 셀 텍스트를 읽는다.
    //   ⚠ 목록은 50행 페이지네이션(실측 "50 / 81")이라 1페이지만 훑으면 대상이 없을 수 있다.
    //     화면의 부분검색 입력에 이름을 넣어 그 행만 남긴 뒤 읽는다(사용자와 동일한 조작).
    const search = page.locator('input[placeholder*="부분검색"]').first();
    for (const t of targets) {
      if (await search.count()) {
        await search.fill("");
        await page.waitForTimeout(300);
        await search.fill(t.name);
        // 고정 sleep 은 디바운스/서버 재조회와 경합해 flaky 하다 — 그 이름 행이 실제로 나타날 때까지 대기.
        await page
          .waitForFunction(
            (n) => [...document.querySelectorAll("table tbody tr")].some((tr) => tr.textContent.includes(n)),
            t.name,
            { timeout: 10000 },
          )
          .catch(() => {});
      }
      const cells = await page.evaluate((name) => {
        const tables = [...document.querySelectorAll("table")];
        for (const tbl of tables) {
          const heads = [...tbl.querySelectorAll("thead th")].map((th) => th.textContent.trim());
          const iName = heads.findIndex((h) => h.includes("이름") || h.includes("성명"));
          const iPart = heads.findIndex((h) => h.includes("파트"));
          const iClass = heads.findIndex((h) => h.includes("클래스"));
          if (iClass < 0) continue;
          for (const tr of [...tbl.querySelectorAll("tbody tr")]) {
            const tds = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
            const rowName = iName >= 0 ? tds[iName] : tds.join(" ");
            if (!rowName || !rowName.includes(name)) continue;
            return { part: iPart >= 0 ? tds[iPart] : null, cls: tds[iClass], heads };
          }
        }
        return null;
      }, t.name);

      // 크루 목록은 서버 고정 50행 페이지네이션(실측 "50 / 81") — 2페이지 이후 대상은 이 화면에서
      //   읽을 수 없다. 렌더 경로 검증 목적상 스킵이며 결함이 아니다(HTTP 는 scan 스크립트가 전수 검증).
      if (!cells) { console.log(`  · ${t.name}: 현재 페이지에 없음(50행 페이지네이션) — 렌더 검증 스킵`); continue; }
      observed++;
      console.log(`  ${t.name}: 화면 렌더 → 파트="${cells.part}" 클래스="${cells.cls}" (멤버십 유도=${t.derived})`);
      ck(`${t.name} 클래스 셀 == override`, cells.cls === CODE_LABEL[t.position_code],
        `렌더="${cells.cls}" 기대="${CODE_LABEL[t.position_code]}"`);
      if (cells.part !== null)
        ck(`${t.name} 소속 파트 셀 == override`, cells.part === t.raw_part,
          `렌더="${cells.part}" 기대="${t.raw_part}"`);
    }
  } finally {
    await browser.close();
  }
  // 전원 스킵되면 아무것도 검증하지 못한 것 — 조용한 통과 금지.
  ck("렌더 관측 대상 ≥1명", observed > 0, `observed=${observed}/${targets.length}`);
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
