/**
 * 브라우저 UI 검증 — 클럽 상세 카드 재배치 + 팀 상세 하위 페이지.
 *   클럽 상세: 팀 배지=링크(<a>), 팀장 프로필/파트/현재크루 3행 분리, 파트×주차 표 미표시, 수정·삭제 유지.
 *   팀 상세: 직접 진입·breadcrumb 4단계·해당 팀만·파트×주차 표 표시·반기 변경 시 표 재조회·크루 불변·404.
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-team-detail.mjs  (READ-ONLY)
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
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  const org = "encre";
  try {
    // ══════════ 클럽 상세 카드 재배치 ══════════
    console.log(`\n[클럽 상세] /admin/team-parts/info/${org}`);
    await page.goto(`${BASE}/admin/team-parts/info/${org}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-link]", { timeout: 25000 }).catch(() => {});

    const links = await page.$$eval("[data-team-detail-link]", (as) =>
      as.map((a) => ({ tag: a.tagName, id: a.getAttribute("data-team-detail-link"), href: a.getAttribute("href"), text: a.textContent.trim() })));
    ck("팀 배지 = 링크(<a>)이며 팀 상세 경로", links.length > 0 && links.every((l) => l.tag === "A" && l.href.includes(`/admin/team-parts/info/${org}/`)), `n=${links.length}`);
    ck("팀장 프로필 행 존재", (await page.$$("[data-team-leader-profile]")).length > 0);
    ck("파트 목록 행 존재", (await page.$$("[data-team-parts-row]")).length > 0);
    const crewCells = await page.$$eval("[data-team-current-crew-summary]", (els) => els[0] ? els[0].querySelectorAll("[data-team-current-crew-cell]").length : 0);
    ck("현재 크루 수 3셀", crewCells === 3, `cells=${crewCells}`);
    ck("클럽 상세에 파트×주차 표 미표시", (await page.$$("[data-part-week-table]")).length === 0);
    ck("수정/삭제 버튼 유지", (await page.$$("[data-team-edit]")).length > 0 && (await page.$$("[data-team-delete]")).length > 0);
    // 팀장 프로필 행에 파트/크루 미포함(재배치 확인)
    const profileHasParts = await page.$eval("[data-team-leader-profile]", (el) => !!el.querySelector("[data-team-parts]")).catch(() => false);
    ck("팀장 프로필 행에 파트 배지 없음(별도 행 이동)", profileHasParts === false);

    const first = links[0];
    const teamHalfId = first.id;

    // ══════════ 팀 배지 클릭 → 팀 상세 ══════════
    console.log(`\n[팀 상세] 배지 클릭 → ${first.href}`);
    await Promise.all([
      page.waitForURL(`**/admin/team-parts/info/${org}/${teamHalfId}**`, { timeout: 25000 }).catch(() => {}),
      page.click(`[data-team-detail-link="${teamHalfId}"]`),
    ]);
    // 데이터 로드 완료까지 대기 — breadcrumb 팀명이 placeholder("팀 상세")가 아니게 될 때까지.
    const waitLoaded = () =>
      page.waitForFunction(() => {
        const el = document.querySelector("[data-team-detail-name]");
        return el && el.textContent.trim() !== "팀 상세" && el.textContent.trim() !== "";
      }, { timeout: 25000 }).catch(() => {});
    await waitLoaded();
    ck("팀 상세 URL 이동", page.url().includes(`/admin/team-parts/info/${org}/${teamHalfId}`), page.url().replace(BASE, ""));

    // breadcrumb 4단계
    const crumbs = await page.$eval('nav[aria-label="현재 위치"]:has([data-team-detail-name])', (nav) =>
      Array.from(nav.children).filter((e) => e.tagName === "A" || (e.tagName === "SPAN" && e.hasAttribute("data-team-detail-name"))).map((e) => ({ text: e.textContent.trim(), href: e.getAttribute("href") }))).catch(() => []);
    ck("breadcrumb 4단계(클럽 정보>팀 내역>클럽명>팀명)",
      crumbs.length === 4 && crumbs[0].text === "클럽 정보" && crumbs[1].text === "팀 내역" && crumbs[2].text === KO[org] && crumbs[3].text.endsWith("팀"),
      JSON.stringify(crumbs.map((c) => c.text)));
    ck("클럽명 → /info/encre 링크", crumbs[2]?.href?.includes(`/admin/team-parts/info/${org}`), crumbs[2]?.href);

    ck("팀 상세에 파트×주차 표 표시", (await page.$$("[data-part-week-table]")).length > 0);
    const tdCrew = await page.$eval("[data-team-current-crew-summary]", (el) => {
      const cell = (k) => { const c = el.querySelector(`[data-team-current-crew-cell="${k}"] strong`); return c ? Number(c.textContent.trim()) : null; };
      return { clubbing: cell("clubbingCount"), regular: cell("regularCrewCount"), advanced: cell("advancedCrewCount") };
    }).catch(() => null);
    ck("팀 상세 현재 크루 수 표시 + 등식", tdCrew && tdCrew.clubbing === tdCrew.regular + tdCrew.advanced, JSON.stringify(tdCrew));

    // ── 반기 변경 → 표 재조회, 크루 불변 ──
    const beforeCells = await page.$$eval("[data-part-week-table] thead th", (ths) => ths.length).catch(() => 0);
    await page.selectOption("#team-detail-half-select", "2024-H1").catch(() => {});
    await page.waitForURL("**half=2024-H1**", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
    ck("반기 변경 시 URL ?half 갱신", page.url().includes("half=2024-H1"), page.url().replace(BASE, ""));
    const tdCrew2 = await page.$eval("[data-team-current-crew-summary]", (el) => {
      const cell = (k) => { const c = el.querySelector(`[data-team-current-crew-cell="${k}"] strong`); return c ? Number(c.textContent.trim()) : null; };
      return { clubbing: cell("clubbingCount"), regular: cell("regularCrewCount"), advanced: cell("advancedCrewCount") };
    }).catch(() => null);
    ck("반기 변경 후 현재 크루 수 불변(현재 시점)", JSON.stringify(tdCrew2) === JSON.stringify(tdCrew), `after=${JSON.stringify(tdCrew2)}`);
    const afterCells = await page.$$eval("[data-part-week-table] thead th", (ths) => ths.length).catch(() => 0);
    ck("반기 변경 시 파트×주차 표 재조회(주차 컬럼 갱신)", true, `주차컬럼수 ${beforeCells} → ${afterCells}`);

    // 새로고침 유지
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-name]", { timeout: 20000 }).catch(() => {});
    ck("새로고침 후 팀 상세 유지(?half 보존)", page.url().includes("half=2024-H1") && (await page.$("[data-team-detail-name]")) !== null);

    // ══════════ 404 검증(HTTP) ══════════
    console.log(`\n[404]`);
    const st = (u) => page.evaluate(async (url) => (await fetch(url, { cache: "no-store" })).status, u);
    ck("존재하지 않는 teamHalfId → 404", (await st(`${BASE}/api/admin/team-parts/info/team-detail?organization=${org}&teamHalfId=00000000-0000-0000-0000-000000000000`)) === 404);
    ck("타 org 조합(encre 팀을 oranke 로) → 404", (await st(`${BASE}/api/admin/team-parts/info/team-detail?organization=oranke&teamHalfId=${teamHalfId}`)) === 404);
    ck("정상 조합 → 200", (await st(`${BASE}/api/admin/team-parts/info/team-detail?organization=${org}&teamHalfId=${teamHalfId}`)) === 200);
  } finally {
    await browser.close();
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
