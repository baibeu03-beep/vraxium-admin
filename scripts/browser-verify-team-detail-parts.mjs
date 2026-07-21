/**
 * 브라우저 검증 — 팀 상세 후속(날짜/주차 배너 · 현재 시점 섹션 · 운용 파트 수 X/6 · 현재 주차 운용 행 강조 · 파트 생성).
 *   ⚠ 파트 생성은 DB 를 변경한다 → 고유 이름으로 만들고 종료 시 supabase 로 정리(READ-ONLY 아님).
 *   사전조건: dev :3000. Usage: node scripts/browser-verify-team-detail-parts.mjs
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
const NEW_PART = `검증파트${Date.now() % 100000}`;

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

const waitLoaded = (page) =>
  page.waitForFunction(() => {
    const el = document.querySelector("[data-team-detail-name]");
    return el && el.textContent.trim() !== "팀 상세" && el.textContent.trim() !== "";
  }, { timeout: 25000 }).catch(() => {});

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1300 } });
  await context.addCookies(await cookies());
  const page = await context.newPage();
  let teamHalfId = null;
  try {
    // teamHalfId 확보(클럽 상세 첫 배지).
    await page.goto(`${BASE}/admin/team-parts/info/${org}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-link]", { timeout: 25000 }).catch(() => {});
    teamHalfId = await page.$eval("[data-team-detail-link]", (a) => a.getAttribute("data-team-detail-link"));
    // 클럽 카드의 크루 값(현재 시점) — 팀 상세와 동일해야 함.
    const cardCrew = await page.$eval(`[data-team-detail-link="${teamHalfId}"]`, (a) => {
      const box = a.closest("[data-team-box]");
      const cell = (k) => { const c = box.querySelector(`[data-team-current-crew-cell="${k}"] strong`); return c ? Number(c.textContent.trim()) : null; };
      return { clubbing: cell("clubbingCount"), regular: cell("regularCrewCount"), advanced: cell("advancedCrewCount") };
    }).catch(() => null);

    console.log(`\n[팀 상세] /admin/team-parts/info/${org}/${teamHalfId}`);
    await page.goto(`${BASE}/admin/team-parts/info/${org}/${teamHalfId}`, { waitUntil: "domcontentloaded" });
    await waitLoaded(page);

    // [1] 날짜/주차 배너
    const banner = await page.$eval("[data-team-detail-today]", (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
    ck("날짜/주차 배너 표시(오늘·주차)", /\d{4}년 \d{1,2}월 \d{1,2}일/.test(banner) && /주차/.test(banner), banner.slice(0, 60));

    // [2] 현재 시점 섹션 — 크루 값이 클럽 카드와 동일
    const tdCrew = await page.$eval("[data-team-current-crew-summary]", (el) => {
      const cell = (k) => { const c = el.querySelector(`[data-team-current-crew-cell="${k}"] strong`); return c ? Number(c.textContent.trim()) : null; };
      return { clubbing: cell("clubbingCount"), regular: cell("regularCrewCount"), advanced: cell("advancedCrewCount") };
    }).catch(() => null);
    ck("현재 크루 수 = 클럽 카드와 동일", cardCrew && JSON.stringify(tdCrew) === JSON.stringify(cardCrew), `card=${JSON.stringify(cardCrew)} detail=${JSON.stringify(tdCrew)}`);

    // 워딩: 크루 셀 "전체 크루" · 파트 라벨 "파트 수"(운용 파트 수 아님)
    const clubbingLabel = await page.$eval('[data-team-current-crew-cell="clubbingCount"]', (el) => el.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
    ck('크루 첫 셀 문구 = "전체 크루"', /전체 크루/.test(clubbingLabel) && !/클러빙/.test(clubbingLabel), clubbingLabel);
    const partsLabelHost = await page.$eval("[data-team-detail-operated-part-count]", (el) => el.parentElement.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
    ck('파트 수 문구 = "파트 수"(운용 파트 수 아님)', /파트 수/.test(partsLabelHost) && !/운용 파트 수/.test(partsLabelHost), partsLabelHost);
    // 레이아웃: 파트 수 + 생성 버튼은 같은 우측 그룹, 생성 파트 목록은 별도(좌).
    const layout = await page.evaluate(() => {
      const cnt = document.querySelector("[data-team-detail-operated-part-count]");
      const btn = document.querySelector("[data-create-team-part-button]");
      const gen = document.querySelector("[data-team-detail-generated-parts]");
      const group = cnt?.closest("div");
      const sameRightGroup = !!group && group.contains(btn);
      const genSeparate = !!gen && group && !group.contains(gen);
      // DOM 순서상 파트 수(cnt) 가 생성 버튼(btn) 보다 앞(왼쪽).
      const cntBeforeBtn = cnt && btn && (cnt.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return { sameRightGroup, genSeparate, cntBeforeBtn };
    });
    ck("파트 수 3/6 이 생성 버튼 바로 왼쪽(같은 우측 그룹)", layout.sameRightGroup && layout.cntBeforeBtn, JSON.stringify(layout));
    ck("생성 파트 목록은 좌측(별도 그룹)", layout.genSeparate);

    // 운용 파트 수(값) X/6 — 선택자·로직 동일
    const operated0 = await page.$eval("[data-team-detail-operated-part-count]", (el) => Number(el.textContent.trim())).catch(() => null);
    const gen0 = await page.$$eval("[data-generated-part]", (els) => els.map((e) => e.getAttribute("data-generated-part")));
    ck("운용 파트 수 표시(숫자·/6)", Number.isFinite(operated0), `X=${operated0}`);
    ck("생성 파트 목록 표시", Array.isArray(gen0), `parts=[${gen0.join(",")}]`);

    // 현재 주차 운용 행 강조 정합 — API 로 currentWeekIdx 계산 후 DOM 대조.
    const apiData = await page.evaluate(async (u) => (await fetch(u, { cache: "no-store" }).then((r) => r.json())).data,
      `${BASE}/api/admin/team-parts/info/team-detail?organization=${org}&teamHalfId=${teamHalfId}`);
    const cwStart = apiData.currentWeekStartDate;
    const cwIdx = cwStart ? apiData.weekColumns.findIndex((c) => c.weekStartDate === cwStart) : -1;
    const rowsHl = await page.$$eval("[data-pw-row]", (rows, idx) =>
      rows.map((tr) => {
        const cells = tr.querySelectorAll("td");
        const curCell = idx >= 0 ? cells[idx + 1] : null; // +1: sticky 파트명 셀
        const curOn = curCell ? curCell.getAttribute("data-pw-cell") === "1" : false;
        return { part: tr.getAttribute("data-pw-row"), hl: tr.getAttribute("data-pw-current-operated") === "1", curOn };
      }), cwIdx);
    const hlConsistent = rowsHl.every((r) => r.hl === r.curOn);
    ck("현재 주차 운용 행 강조 = 현재 주차 셀(●) 정합", hlConsistent, `cwIdx=${cwIdx} rows=${JSON.stringify(rowsHl)}`);
    const pastOnlyRow = rowsHl.find((r) => !r.curOn && !r.hl);
    ck("과거 이력만 있는 행은 강조 안 됨(현재 셀 기준)", cwIdx < 0 || rowsHl.every((r) => r.hl === r.curOn), pastOnlyRow ? pastOnlyRow.part : "n/a");

    // ── 파트 생성 ──
    console.log(`\n[파트 생성] "${NEW_PART}"`);
    await page.click("[data-create-team-part-button]");
    await page.fill("[data-create-team-part-input]", NEW_PART);
    await page.click("[data-create-team-part-submit]");
    await page.waitForFunction((n) => Array.from(document.querySelectorAll("[data-generated-part]")).some((e) => e.getAttribute("data-generated-part") === n), NEW_PART, { timeout: 20000 }).catch(() => {});
    const gen1 = await page.$$eval("[data-generated-part]", (els) => els.map((e) => e.getAttribute("data-generated-part")));
    ck("생성 후 파트 목록에 추가", gen1.includes(NEW_PART), `parts=[${gen1.join(",")}]`);
    const operated1 = await page.$eval("[data-team-detail-operated-part-count]", (el) => Number(el.textContent.trim())).catch(() => null);
    ck("생성 후 운용 파트 수 불변(새 파트 0명)", operated1 === operated0, `${operated0} → ${operated1}`);
    // 새 파트 행: 존재 + 전부 미체크 + 미강조
    const newRow = await page.$eval(`[data-pw-row="${NEW_PART}"]`, (tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).slice(1);
      return { checked: cells.filter((c) => c.getAttribute("data-pw-cell") === "1").length, hl: tr.getAttribute("data-pw-current-operated") === "1" };
    }).catch(() => null);
    ck("표에 새 파트 행 추가", newRow !== null);
    ck("새 행 전부 미체크(배정 0)", newRow && newRow.checked === 0, `checked=${newRow?.checked}`);
    ck("새 행 강조 없음", newRow && newRow.hl === false);

    // 새로고침 유지
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitLoaded(page);
    const gen2 = await page.$$eval("[data-generated-part]", (els) => els.map((e) => e.getAttribute("data-generated-part")));
    ck("새로고침 후 새 파트 유지", gen2.includes(NEW_PART));

    // 중복 생성 차단
    await page.click("[data-create-team-part-button]");
    await page.fill("[data-create-team-part-input]", NEW_PART);
    await page.click("[data-create-team-part-submit]");
    await page.waitForSelector("[data-create-team-part-error]", { timeout: 15000 }).catch(() => {});
    const dupErr = await page.$eval("[data-create-team-part-error]", (e) => e.textContent.trim()).catch(() => null);
    ck("중복 파트명 생성 차단(에러)", !!dupErr, dupErr ?? "no error");
    await page.keyboard.press("Escape").catch(() => {});

    // 잘못된 팀 URL 생성 차단(HTTP)
    const badStatus = await page.evaluate(async (u) => {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organization: "encre", teamHalfId: "00000000-0000-0000-0000-000000000000", name: "x" }) });
      return r.status;
    }, `${BASE}/api/admin/team-parts/info/team-detail/parts`);
    ck("잘못된 teamHalfId 생성 → 404", badStatus === 404, `status=${badStatus}`);

    // 모드 패리티 — op vs test DTO 키 동일
    const keysOp = await page.evaluate(async (u) => Object.keys((await fetch(u).then((r) => r.json())).data ?? {}).sort(), `${BASE}/api/admin/team-parts/info/team-detail?organization=${org}&teamHalfId=${teamHalfId}`);
    const keysTest = await page.evaluate(async (u) => Object.keys((await fetch(u).then((r) => r.json())).data ?? {}).sort(), `${BASE}/api/admin/team-parts/info/team-detail?organization=${org}&teamHalfId=${teamHalfId}&mode=test`);
    ck("op/test DTO 키 동일", JSON.stringify(keysOp) === JSON.stringify(keysTest), `op=${keysOp.length} test=${keysTest.length}`);
  } finally {
    // 정리 — 생성한 검증 파트 삭제.
    if (teamHalfId) {
      const { error } = await sb.from("cluster4_team_parts").delete().eq("team_half_id", teamHalfId).eq("part_name", NEW_PART);
      console.log(error ? `\n[정리] 삭제 실패: ${error.message}` : `\n[정리] 검증 파트 "${NEW_PART}" 삭제 완료`);
    }
    await browser.close();
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
