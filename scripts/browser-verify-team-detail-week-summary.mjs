/**
 * 브라우저 검증 — 팀 상세 [A] 선택 주차 요약(주차 select·크루/성장 2카드·운용 파트).
 *   기본 현재 주차·미래 없음·과거 선택·주차 변경 시 [A]만 갱신(매트릭스 불변)·등식·DOM==API·op==test.
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-team-detail-week-summary.mjs  (READ-ONLY)
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
const org = "encre";

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

const readA = (page) =>
  page.$eval("[data-team-detail-week-summary]", (root) => {
    const num = (sel) => { const e = root.querySelector(sel); return e ? Number(e.textContent.trim()) : null; };
    const parts = Array.from(root.querySelectorAll("[data-selected-week-operated-part]")).map((e) => ({
      name: e.getAttribute("data-selected-week-operated-part"),
      count: Number(e.querySelector("strong")?.textContent.trim() ?? "0"),
    }));
    return {
      total: num("[data-selected-week-total-crew-count]"),
      regular: num("[data-selected-week-regular-crew-count]"),
      advanced: num("[data-selected-week-advanced-crew-count]"),
      success: num("[data-selected-week-growth-success-count]"),
      failure: num("[data-selected-week-growth-failure-count]"),
      rest: num("[data-selected-week-growth-rest-count]"),
      operatedCount: num("[data-selected-week-operated-part-count]"),
      parts,
      weekVal: root.querySelector("#team-detail-week-select")?.value ?? null,
      curOptionSelected: (() => {
        const sel = root.querySelector("#team-detail-week-select");
        const opt = sel?.selectedOptions?.[0];
        return opt ? /\(현재\)/.test(opt.textContent) : false;
      })(),
    };
  });

const waitA = (page) =>
  page.waitForFunction(() => {
    const e = document.querySelector("[data-selected-week-total-crew-count]");
    return e && e.textContent.trim() !== "";
  }, { timeout: 25000 }).catch(() => {});

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/admin/team-parts/info/${org}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-link]", { timeout: 30000 }).catch(() => {});
    const teamHalfId = await page.$eval("[data-team-detail-link]", (a) => a.getAttribute("data-team-detail-link"));

    console.log(`\n[팀 상세 A] /admin/team-parts/info/${org}/${teamHalfId}`);
    await page.goto(`${BASE}/admin/team-parts/info/${org}/${teamHalfId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-week-summary]", { timeout: 30000 }).catch(() => {});
    await waitA(page);
    ck("[A] 영역 존재", (await page.$("[data-team-detail-week-summary]")) !== null);

    const a0 = await readA(page);
    ck("기본 선택 = 현재 주차", a0.curOptionSelected === true, `weekVal=${a0.weekVal}`);
    // 옵션 표시명 = 연도+시즌+주차 (동일 주차번호 시즌 구분). 예: "26년, 여름, 4주차 (현재)".
    const optTexts = await page.$$eval("#team-detail-week-select option", (os) => os.map((o) => o.textContent.trim()));
    const selText = await page.$eval("#team-detail-week-select", (s) => s.selectedOptions[0]?.textContent.trim() ?? "");
    ck("옵션 표시 = 연도+시즌+주차", /\d{2}년,\s*\S+,\s*\d+주차/.test(selText), selText);
    ck("현재 옵션에 (현재) 표기", /\(현재\)/.test(selText));
    ck("옵션이 연도/시즌으로 구분됨(단순 'N주차' 아님)", optTexts.length > 1 && optTexts.every((t) => /\d{2}년,/.test(t)), `샘플=${optTexts.slice(0, 3).join(" | ")}`);
    // 0주차(전환) 제외 — 드롭다운·매트릭스 모두.
    ck("드롭다운 0주차 제외", optTexts.every((t) => !/,\s*0주차/.test(t)), `옵션에 0주차 포함? ${optTexts.filter((t) => /,\s*0주차/.test(t)).join(",") || "없음"}`);
    const thTexts = await page.$$eval("[data-part-week-table] thead th", (ts) => ts.map((t) => t.textContent.trim())).catch(() => []);
    ck("매트릭스 0주차 컬럼 제외", thTexts.length > 0 && thTexts.every((t) => !/\s0$/.test(t)), `0주차 헤더? ${thTexts.filter((t) => /\s0$/.test(t)).join(",") || "없음"}`);
    ck("전체/정규/심화 표시", [a0.total, a0.regular, a0.advanced].every(Number.isFinite), JSON.stringify([a0.total, a0.regular, a0.advanced]));
    ck("성장 성공/실패/휴식 표시", [a0.success, a0.failure, a0.rest].every(Number.isFinite), JSON.stringify([a0.success, a0.failure, a0.rest]));
    ck("전체 = 정규 + 심화", a0.total === a0.regular + a0.advanced);
    ck("운용 파트 개수 = 배지 수", a0.operatedCount === a0.parts.length, `${a0.operatedCount} vs ${a0.parts.length}`);
    ck("운용 파트 crewCount>=1", a0.parts.every((p) => p.count >= 1), JSON.stringify(a0.parts));

    // DOM == API(현재 주차)
    const api0 = await page.evaluate(async (u) => (await fetch(u).then((r) => r.json())).data, `${BASE}/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${teamHalfId}`);
    ck("DOM 값 == API(현재 주차)",
      a0.total === api0.crew.total && a0.regular === api0.crew.regular && a0.advanced === api0.crew.advanced &&
      a0.success === api0.growth.success && a0.failure === api0.growth.failure && a0.rest === api0.growth.rest &&
      a0.operatedCount === api0.operatedParts.length,
      `A=${JSON.stringify([a0.total, a0.success, a0.operatedCount])} API=${JSON.stringify([api0.crew.total, api0.growth.success, api0.operatedParts.length])}`);
    ck("미래 주차 없음(선택목록 첫 옵션이 현재)", api0.selectableWeeks[0]?.isCurrent === true);

    // 매트릭스 컬럼 수(불변 확인 기준값)
    const mBefore = await page.$$eval("[data-part-week-table] thead th", (t) => t.length).catch(() => 0);

    // 과거 주차로 변경 → [A]만 갱신
    const pastId = api0.selectableWeeks.find((w) => !w.isCurrent)?.weekId;
    if (pastId) {
      await page.selectOption("#team-detail-week-select", pastId);
      await page.waitForFunction(
        (cur) => { const s = document.querySelector("#team-detail-week-select"); return s && s.value !== cur; },
        a0.weekVal, { timeout: 15000 },
      ).catch(() => {});
      await page.waitForTimeout(1500);
      const a1 = await readA(page);
      ck("과거 주차 선택 반영", a1.weekVal === pastId, `weekVal=${a1.weekVal}`);
      ck("과거 주차 전체 = 정규 + 심화", a1.total === a1.regular + a1.advanced);
      const apiP = await page.evaluate(async (u) => (await fetch(u).then((r) => r.json())).data, `${BASE}/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${teamHalfId}&weekId=${pastId}`);
      ck("과거 주차 DOM == API", a1.total === apiP.crew.total && a1.success === apiP.growth.success && a1.failure === apiP.growth.failure);
      const mAfter = await page.$$eval("[data-part-week-table] thead th", (t) => t.length).catch(() => 0);
      ck("주차 변경해도 매트릭스(주차별 파트 운용 상태표) 불변", mBefore === mAfter, `${mBefore} → ${mAfter}`);
    } else {
      ck("과거 주차 존재(선택 테스트)", false, "no past week");
    }

    // op == test DTO 키
    const keysOp = await page.evaluate(async (u) => Object.keys((await fetch(u).then((r) => r.json())).data ?? {}).sort(), `${BASE}/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${teamHalfId}`);
    const keysTs = await page.evaluate(async (u) => Object.keys((await fetch(u).then((r) => r.json())).data ?? {}).sort(), `${BASE}/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${teamHalfId}&mode=test`);
    ck("op/test DTO 키 동일", JSON.stringify(keysOp) === JSON.stringify(keysTs), `op=${keysOp.length} test=${keysTs.length}`);
  } finally {
    await browser.close();
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
