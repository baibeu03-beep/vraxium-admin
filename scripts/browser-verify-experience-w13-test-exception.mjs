// 브라우저(인증) HTTP + DOM 검증 — 실무 경험 테스트 모드 + encre 한정 13주차 개설 예외.
//   실제 admin 세션으로:
//     [0] weeks-options(공용 SoT) mode 무관 동일 — 다른 허브 무영향 회귀 가드.
//     [1] experience/opening-status operating/test × org 분기(== direct):
//          encre+test → targetWeek=W13(2026-05-25, 활동) / 그 외 → 정규 W15(휴식).
//     [2] DOM — /admin/line-opening/practical-experience?org=encre&mode=test&tab=open 의
//          "개설 주차" 셀렉트에 W13 옵션이 있고(enabled) 기본 선택값인지(실제 개설 가능).
//     [3] operating 페이지에는 W13 미노출(예외 미적용).
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

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre&tab=open`, { waitUntil: "domcontentloaded" });

async function httpGet(url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data ?? null, success: j?.success ?? false };
  }, url);
}

try {
  const ORGS = ["oranke", "encre", "phalanx", "olympus"];

  // [0] weeks-options 공용 SoT mode 무관 동일.
  console.log("\n[0] weeks-options 공용 SoT mode 무관 동일(다른 허브 무영향)");
  const woOp = await httpGet(`/api/admin/cluster4/weeks-options?limit=8`);
  const woTs = await httpGet(`/api/admin/cluster4/weeks-options?limit=8&mode=test`);
  const tOp = (woOp.data?.weeks ?? []).find((w) => w.isOpenTarget);
  const tTs = (woTs.data?.weeks ?? []).find((w) => w.isOpenTarget);
  check("weeks-options isOpenTarget mode 무관 동일", tOp?.startDate === tTs?.startDate, `op=${tOp?.startDate} ts=${tTs?.startDate}`);

  // [1] opening-status operating/test × org 분기(== direct).
  console.log("\n[1] experience/opening-status operating/test × org 분기 (== direct)");
  for (const org of ORGS) {
    const op = await httpGet(`/api/admin/cluster4/experience/opening-status?organization=${org}`);
    const ts = await httpGet(`/api/admin/cluster4/experience/opening-status?organization=${org}&mode=test`);
    const ow = op.data?.targetWeek, tw = ts.data?.targetWeek;
    console.log(`  [${org}] operating W${ow?.weekNumber}(${ow?.startDate}) id=${op.data?.targetWeekId?.slice(0,8)} / test W${tw?.weekNumber}(${tw?.startDate}) id=${ts.data?.targetWeekId?.slice(0,8)}`);
    // 운영 = 정규 W15(휴식) — 회귀 0.
    check(`[${org}] operating targetWeek=W15(2026-06-08, 휴식)`, op.status === 200 && ow?.weekNumber === 15 && ow?.startDate === "2026-06-08");
    if (org === "encre") {
      // test = W13(2026-05-25, 활동) + targetWeekId 존재.
      check(`[encre] test targetWeek=W13(2026-05-25, 활동)`, ts.status === 200 && tw?.weekNumber === 13 && tw?.startDate === "2026-05-25" && tw?.isOfficialRest === false);
      check(`[encre] test targetWeekId 존재(개설 주차)`, Boolean(ts.data?.targetWeekId));
      check(`[encre] operating ≠ test (예외 실제 분기)`, ow?.startDate !== tw?.startDate);
    } else {
      // 타 조직 test == operating(예외 미적용).
      check(`[${org}] test == operating(예외 미적용·회귀 0)`, tw?.startDate === ow?.startDate && ts.data?.targetWeekId === op.data?.targetWeekId);
    }
  }

  // [2] DOM — encre+test 페이지의 "개설 주차" 셀렉트에 W13 이 있고 기본 선택값인지.
  console.log("\n[2] DOM: encre+test 개설 주차 셀렉트 W13 enabled + 기본 선택");
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre&mode=test&tab=open`, { waitUntil: "domcontentloaded" });
  // "개설 주차" 라벨 옆 select 가 렌더될 때까지 대기(part-input 부트 후).
  await page.waitForFunction(() => {
    const labels = Array.from(document.querySelectorAll("label"));
    const lab = labels.find((l) => l.textContent?.includes("개설 주차"));
    if (!lab) return false;
    const sel = lab.parentElement?.querySelector("select");
    return sel && sel.options.length > 0;
  }, { timeout: 20000 }).catch(() => {});
  const domTest = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label"));
    const lab = labels.find((l) => l.textContent?.includes("개설 주차"));
    const sel = lab?.parentElement?.querySelector("select");
    if (!sel) return { found: false };
    const opts = Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent?.trim() ?? "", disabled: o.disabled }));
    const w13 = opts.find((o) => o.text.includes("W13"));
    const selected = opts.find((o) => o.value === sel.value);
    return { found: true, selectedText: selected?.text, selectedValue: sel.value, w13, optCount: opts.length };
  });
  check("[encre+test] 개설 주차 셀렉트 렌더됨", domTest.found === true);
  check("[encre+test] W13 옵션 존재", Boolean(domTest.w13), `opt="${domTest.w13?.text ?? "(없음)"}"`);
  check("[encre+test] W13 옵션 enabled(개설 가능·휴식 아님)", domTest.w13 ? domTest.w13.disabled === false : false);
  check("[encre+test] 기본 선택값 == W13(개설 대상 자동 고정)", Boolean(domTest.selectedText?.includes("W13")), `selected="${domTest.selectedText}"`);

  // [3] operating 페이지에는 W13 미노출(예외 미적용·운영 영향 0).
  console.log("\n[3] DOM: operating 페이지 W13 미노출(예외 미적용)");
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre&tab=open`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const labels = Array.from(document.querySelectorAll("label"));
    const lab = labels.find((l) => l.textContent?.includes("개설 주차"));
    const sel = lab?.parentElement?.querySelector("select");
    return sel && sel.options.length > 0;
  }, { timeout: 20000 }).catch(() => {});
  const domOp = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll("label"));
    const lab = labels.find((l) => l.textContent?.includes("개설 주차"));
    const sel = lab?.parentElement?.querySelector("select");
    if (!sel) return { found: false };
    const opts = Array.from(sel.options).map((o) => o.textContent?.trim() ?? "");
    const selected = Array.from(sel.options).find((o) => o.value === sel.value);
    return { found: true, hasW13: opts.some((t) => t.includes("W13")), selectedText: selected?.textContent?.trim() };
  });
  check("[encre+operating] 개설 주차 셀렉트 렌더됨", domOp.found === true);
  check("[encre+operating] W13 옵션 미노출(운영 영향 0)", domOp.found ? domOp.hasW13 === false : false, `selected="${domOp.selectedText}"`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
