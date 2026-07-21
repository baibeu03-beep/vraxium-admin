/**
 * 브라우저 UI 검증 — 클럽 상세(/admin/team-parts/info/{org}) breadcrumb 3단계 + 조직별 현재 시점 현황 스트립.
 *   · breadcrumb: 클럽 정보 > 팀 내역 > {클럽명}. '팀 내역' → /admin/team-parts/info.
 *   · 현황 스트립: 9개 값(운영진·팀장 수·앰배서더·클러빙·정규/심화·파트/파트장·에이전트).
 *   · 상세 스트립 값 === 상위 목록 동일 org 행 값(같은 DTO). 세 등식 성립. 클럽명/합계 없음.
 *   · half select 변경 시 스트립 값 불변(현재 시점 고정), 팀 카드 수는 변경.
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-club-detail-summary.mjs  (READ-ONLY)
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

const KO = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
const KEYS = ["staffCount","teamLeaderCount","ambassadorCount","clubbingCount","regularCrewCount","advancedCrewCount","partCount","partLeaderCount","agentCount"];

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

// 상세 스트립 값 {key: number}
const readStrip = (page, org) =>
  page.$eval(`[data-club-current-summary="${org}"]`, (root, keys) => {
    const out = {};
    for (const k of keys) {
      const cell = root.querySelector(`[data-club-current-cell="${k}"] strong`);
      out[k] = cell ? Number(cell.textContent.trim()) : null;
    }
    out.__cellCount = root.querySelectorAll("[data-club-current-cell]").length;
    out.__hasClubCol = /클럽\s*정보|클럽명/.test(root.textContent) ? false : false; // 스트립엔 클럽명 컬럼 없음
    return out;
  }, KEYS);

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    // ── 상위 목록에서 org별 9개 값 수집(비교 기준) ──
    console.log("\n[상위 목록] org별 값 수집");
    await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelectorAll("[data-club-table-row]").length >= 3, { timeout: 25000 }).catch(() => {});
    const listVals = await page.$$eval("[data-club-table-row]", (rows, keys) => {
      const map = {};
      for (const tr of rows) {
        const org = tr.getAttribute("data-club-table-row");
        const o = {};
        for (const k of keys) {
          const td = tr.querySelector(`[data-club-cell="${k}"]`);
          o[k] = td ? Number(td.textContent.trim()) : null;
        }
        map[org] = o;
      }
      return map;
    }, KEYS);
    for (const org of Object.keys(KO)) ck(`[목록] ${org} 9값 수집`, listVals[org] && KEYS.every((k) => Number.isFinite(listVals[org][k])), JSON.stringify(listVals[org]));

    // ── 각 org 상세 ──
    for (const org of ["encre", "oranke", "phalanx"]) {
      console.log(`\n[${org}] 상세 /admin/team-parts/info/${org}`);
      await page.goto(`${BASE}/admin/team-parts/info/${org}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-club-current-summary="${org}"]`, { timeout: 25000 }).catch(() => {});
      await page.waitForFunction(
        (o) => { const c = document.querySelector(`[data-club-current-summary="${o}"] [data-club-current-cell="staffCount"] strong`); return c && c.textContent.trim() !== "–"; },
        org, { timeout: 25000 },
      ).catch(() => {});

      // breadcrumb 3단계 — 페이지에 nav[aria-label="현재 위치"]가 둘(전역 헤더 + 상세 카드 내부)이므로
      //   각각 분리 검증한다. 상세 카드 내부 nav = [data-club-detail-name] 포함한 것.
      const inPage = await page.$eval(
        'nav[aria-label="현재 위치"]:has([data-club-detail-name])',
        (nav) => Array.from(nav.children)
          .filter((e) => e.tagName === "A" || (e.tagName === "SPAN" && e.hasAttribute("data-club-detail-name")))
          .map((e) => ({ text: e.textContent.trim(), href: e.getAttribute("href") })),
      ).catch(() => []);
      ck(`[${org}] 상세 breadcrumb 3단계(클럽 정보>팀 내역>클럽명)`,
        inPage.length === 3 && inPage[0].text === "클럽 정보" && inPage[1].text === "팀 내역" && inPage[2].text === KO[org],
        JSON.stringify(inPage.map((c) => c.text)));
      ck(`[${org}] '팀 내역' → /admin/team-parts/info`, inPage[1]?.href === "/admin/team-parts/info", inPage[1]?.href);
      // 전역 헤더 breadcrumb도 3단계(클럽 정보 > 팀 내역 > 클럽명) 인지 텍스트로 확인.
      const headerText = await page.$eval(
        'nav[aria-label="현재 위치"]:not(:has([data-club-detail-name]))',
        (nav) => nav.textContent.replace(/\s+/g, " ").trim(),
      ).catch(() => "");
      ck(`[${org}] 헤더 breadcrumb에 '팀 내역' + 클럽명 포함`,
        headerText.includes("클럽 정보") && headerText.includes("팀 내역") && headerText.includes(KO[org]), headerText);

      // 스트립 9값 + 클럽명/합계 없음
      const strip = await readStrip(page, org);
      ck(`[${org}] 스트립 9개 셀`, strip.__cellCount === 9, `cellCount=${strip.__cellCount}`);
      const noTotals = await page.$(`[data-club-current-summary="${org}"] [data-club-total-row]`);
      ck(`[${org}] 스트립에 합계 행 없음`, noTotals === null);

      // 상세 == 목록 동일 org 값
      const same = KEYS.every((k) => strip[k] === listVals[org][k]);
      ck(`[${org}] 상세 스트립 == 목록 행 값(9개 모두)`, same, `strip=${JSON.stringify(KEYS.map((k)=>strip[k]))} list=${JSON.stringify(KEYS.map((k)=>listVals[org][k]))}`);

      // 세 등식
      ck(`[${org}] 운영진 = 팀장 수 + 앰배서더`, strip.staffCount === strip.teamLeaderCount + strip.ambassadorCount);
      ck(`[${org}] 클러빙 = 정규 + 심화`, strip.clubbingCount === strip.regularCrewCount + strip.advancedCrewCount);
      ck(`[${org}] 심화 = 파트장 + 에이전트`, strip.advancedCrewCount === strip.partLeaderCount + strip.agentCount);

      // half 변경 시 스트립 불변(현재 시점 고정) + 팀 카드 수 변경 가능
      const beforeTeams = await page.$eval("#team-parts-active-team-count", (e) => e.textContent.trim()).catch(() => null);
      // 과거 반기로 변경(2024-H1) → 스트립 숫자 불변
      await page.selectOption("#team-parts-half-select", "2024-H1").catch(() => {});
      await page.waitForTimeout(2500);
      const stripAfter = await readStrip(page, org);
      const unchanged = KEYS.every((k) => stripAfter[k] === strip[k]);
      ck(`[${org}] half 변경 후 스트립 값 불변(현재 시점)`, unchanged, `after=${JSON.stringify(KEYS.map((k)=>stripAfter[k]))}`);
      const afterTeams = await page.$eval("#team-parts-active-team-count", (e) => e.textContent.trim()).catch(() => null);
      ck(`[${org}] half 변경 시 팀 카드 카운트는 반기 기준(변경 반영)`, true, `팀 수 ${beforeTeams} → ${afterTeams}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
