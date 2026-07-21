/**
 * 브라우저 UI 검증 — 클럽 목록(상위) + 클럽 상세(하위) 분리.
 *   상위: 클럽 탭 제거·클럽별 1행·10컬럼·합계행·행/합계 세 등식·클럽명 링크 이동·뒤로가기 복귀.
 *   상세: 클럽 탭 없음·breadcrumb "클럽 정보 > 실제 클럽명"·팀/등록/파트×주차·직접진입/새로고침·잘못된 clubId not-found.
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-club-summary.mjs  (READ-ONLY)
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

const NUM_KEYS = ["staffCount","teamLeaderCount","ambassadorCount","clubbingCount","regularCrewCount","advancedCrewCount","partCount","partLeaderCount","agentCount"];
const HEADERS = ["클럽","운영진","팀장 수","앰배서더","클러빙","정규 크루","심화 크루","파트 수","파트장 수","에이전트 수"];

const waitList = (page) =>
  page.waitForFunction(() => document.querySelectorAll("[data-club-table-row]").length > 0, { timeout: 25000 }).catch(() => {});

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    // ══════════ 상위 목록 ══════════
    console.log("\n[상위 목록]");
    await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "domcontentloaded" });
    await waitList(page);
    await page.waitForFunction(
      () => (document.querySelector("[data-current-date]")?.textContent ?? "-").trim() !== "-",
      { timeout: 25000 },
    ).catch(() => {});
    await page.waitForTimeout(200);

    // ── [섹션.1] 기존 요약 유지 확인 ──
    const date = (await page.locator("[data-current-date]").innerText().catch(() => "-")).trim();
    const week = (await page.locator("[data-current-week]").innerText().catch(() => "-")).trim();
    ck("§1 오늘 날짜·현재 주차 표시", date !== "-" && week !== "-", `${date} / ${week}`);
    ck("§1 전체 클럽/팀/파트 수 표시",
      (await page.locator("#team-parts-club-count").count()) === 1 &&
      (await page.locator("#team-parts-total-team-count").count()) === 1 &&
      (await page.locator("#team-parts-total-part-count").count()) === 1);
    // 상위 페이지 = 현재 시점 전용 → 해당 시기 select 는 없어야 한다(상세 페이지 전용).
    ck("§1 해당 시기 select 없음(상위=현재시점)", (await page.locator("#team-parts-half-select").count()) === 0);
    const badgeRows = await page.locator("[data-club-row]").count();
    ck("§1 클럽별 팀 배지 행 3개", badgeRows === 3, `rows=${badgeRows}`);
    // §1 배지는 링크가 아님(정보 표시용)
    ck("§1 배지 영역에 상세 링크 없음",
      (await page.locator('[data-club-row] a[href^="/admin/team-parts/info/"]').count()) === 0);

    // ── DOM 순서: 요약(§1) 이 표(§2) 보다 위 ──
    const order = await page.evaluate(() => {
      const s = document.querySelector("[data-current-date]");
      const t = document.querySelector("[data-club-table-row]");
      if (!s || !t) return null;
      return s.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING ? "summary-first" : "table-first";
    });
    ck("DOM 순서: 요약 → 표", order === "summary-first", `order=${order}`);

    ck("표 영역 클럽 탭 없음", (await page.locator("[data-org-tab]").count()) === 0);
    const rowCount = await page.locator("[data-club-table-row]").count();
    ck("표: 클럽별 1행(3개)", rowCount === 3, `rows=${rowCount}`);

    const headers = await page.locator("table thead th").allInnerTexts();
    const cleaned = headers.map((h) => h.replace(/\s+/g, " ").trim());
    const headersOk = HEADERS.every((h, i) => cleaned[i]?.startsWith(h.replace(/\s+/g, " ")) || cleaned[i]?.includes(h));
    ck("10개 컬럼 순서", headersOk, JSON.stringify(cleaned));

    // 각 행 수치 + 세 등식
    const readRow = async (org) => {
      const o = {};
      for (const k of NUM_KEYS) {
        const txt = await page.locator(`[data-club-table-row="${org}"] [data-club-cell="${k}"]`).innerText();
        o[k] = Number(txt.trim());
      }
      return o;
    };
    for (const org of ["encre","oranke","phalanx"]) {
      const r = await readRow(org);
      const allNum = NUM_KEYS.every((k) => Number.isFinite(r[k]));
      const eq1 = r.staffCount === r.teamLeaderCount + r.ambassadorCount;
      const eq2 = r.clubbingCount === r.regularCrewCount + r.advancedCrewCount;
      const eq3 = r.advancedCrewCount === r.partLeaderCount + r.agentCount;
      ck(`${org} 수치 표시(0도 0)`, allNum, JSON.stringify(r));
      ck(`${org} 세 등식`, eq1 && eq2 && eq3, `${eq1}/${eq2}/${eq3}`);
    }

    // 합계 행 + 등식
    const totalRow = page.locator("[data-club-total-row]");
    ck("합계 행 표시", (await totalRow.count()) === 1);
    const tot = {};
    for (const k of NUM_KEYS) tot[k] = Number((await page.locator(`[data-club-total="${k}"]`).innerText()).trim());
    const teq1 = tot.staffCount === tot.teamLeaderCount + tot.ambassadorCount;
    const teq2 = tot.clubbingCount === tot.regularCrewCount + tot.advancedCrewCount;
    const teq3 = tot.advancedCrewCount === tot.partLeaderCount + tot.agentCount;
    ck("합계 세 등식", teq1 && teq2 && teq3, JSON.stringify(tot));

    // 클럽명 링크 → 상세 이동(URL 변경)
    await page.locator('[data-club-link="encre"]').click();
    await page.waitForURL(/\/admin\/team-parts\/info\/encre/, { timeout: 15000 }).catch(() => {});
    ck("클럽명 클릭 → URL /info/encre", /\/admin\/team-parts\/info\/encre/.test(page.url()), page.url());
    await page.waitForFunction(() => document.querySelector("[data-club-detail-name]"), { timeout: 15000 }).catch(() => {});
    ck("상세: breadcrumb 클럽명 = 엥크레",
      (await page.locator("[data-club-detail-name]").innerText().catch(() => "")).trim() === "엥크레");

    // 뒤로가기 → 목록 복귀
    await page.goBack({ waitUntil: "domcontentloaded" });
    await waitList(page);
    ck("뒤로가기 → 목록 복귀", (await page.locator("[data-club-table-row]").count()) === 3 && /\/admin\/team-parts\/info$/.test(page.url().split("?")[0]), page.url());

    // ══════════ 상세(직접 진입) ══════════
    console.log("\n[상세 직접 진입]");
    await page.goto(`${BASE}/admin/team-parts/info/phalanx`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#team-parts-register-box", { timeout: 20000 }).catch(() => {});
    ck("상세 클럽 탭 없음", (await page.locator("[data-org-tab]").count()) === 0);
    ck("breadcrumb = 팔랑크스", (await page.locator("[data-club-detail-name]").innerText().catch(() => "")).trim() === "팔랑크스");
    // 목록 복귀 링크(카드 내부 breadcrumb nav 로 스코프 — 전역 헤더 breadcrumb 와 구분).
    // breadcrumb = 클럽 정보 > 팀 내역 > 클럽명(3단계·앞 2개는 목록 복귀 링크). 마지막 링크로 확인.
    const navLinks = page.locator('nav:has([data-club-detail-name]) a');
    const backHref = await navLinks.last().getAttribute("href").catch(() => null);
    const allToList = (await navLinks.evaluateAll((els) => els.map((e) => e.getAttribute("href")))).every(
      (h) => h === "/admin/team-parts/info",
    );
    ck("breadcrumb 목록 복귀 링크(전부 /info)", backHref === "/admin/team-parts/info" && allToList, `href=${backHref}`);
    ck("해당 시기 select 존재", (await page.locator("#team-parts-half-select").count()) === 1);
    ck("팀 등록 박스 존재", (await page.locator("#team-parts-register-box").count()) === 1);

    // selectedHalf 동작 — 과거 반기 선택 시 상세가 그 반기로 재조회(현재 시점 아님).
    //   controlled select 라 async 재조회(setHalf)가 끝나야 값이 확정된다 → 값 확정까지 대기.
    await page.selectOption("#team-parts-half-select", "2024-H1").catch(() => {});
    const settled = await page
      .waitForFunction(
        () => document.querySelector("#team-parts-half-select")?.value === "2024-H1",
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    const selVal = await page.locator("#team-parts-half-select").inputValue().catch(() => "");
    ck("상세: 해당 시기(2024-H1) 선택 반영 = selectedHalf 동작", settled && selVal === "2024-H1", `val=${selVal}`);

    // 새로고침 정상
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("[data-club-detail-name]"), { timeout: 15000 }).catch(() => {});
    ck("새로고침 후 상세 유지", (await page.locator("[data-club-detail-name]").innerText().catch(() => "")).trim() === "팔랑크스");

    // 다른 클럽 URL 이동 시 이전 데이터 잔상 없음(로딩 상태 경유)
    await page.goto(`${BASE}/admin/team-parts/info/oranke`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (document.querySelector("[data-club-detail-name]")?.textContent ?? "").trim() === "오랑캐", { timeout: 15000 }).catch(() => {});
    ck("다른 클럽 이동 → 오랑캐", (await page.locator("[data-club-detail-name]").innerText().catch(() => "")).trim() === "오랑캐");

    // ══════════ 잘못된 clubId ══════════
    console.log("\n[잘못된 clubId]");
    await page.goto(`${BASE}/admin/team-parts/info/notaclub`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const hasDetail = (await page.locator("[data-club-detail-name]").count()) > 0;
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const notFoundUi = /찾을 수 없|not found|could not be found|404/i.test(bodyText);
    ck("잘못된 clubId → not-found(상세 미렌더)", !hasDetail && notFoundUi, `detail=${hasDetail} nf=${notFoundUi}`);

    console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
  } finally {
    await browser.close();
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
