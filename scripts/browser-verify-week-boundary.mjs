// 브라우저 검증 — 월요일 00:01 KST 경계 적용 후 운영자 화면이 현재 시즌/주차를 올바르게 표시하는지.
//   1) /admin/line-opening/practical-experience 상태창(블록1 "오늘/이번 주")에 현재 시즌·주차 텍스트
//      ("여름 시즌", "1주차") 가 렌더된다.
//   2) 같은 브라우저 세션으로 /api/admin/cluster4/current-week 를 in-page fetch → seasonKey=2026-summer,
//      weekNumber=1 (브라우저→API→데이터 전 경로 일치).
// read-only · net-zero (DB 변경 없음).
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
const adminEmail = "vanuatu.golden@gmail.com";
const BASE = "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sbAdmin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sbAdmin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const cookies = await makeAdminCookies();
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1800 } });
await context.addCookies(cookies);
const page = await context.newPage();
try {
  // 1) 운영자 라인 개설 상태창 — 현재 시즌/주차 표시.
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=oranke`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('오늘은') || document.body.innerText.includes('이번 주')", undefined, { timeout: 30000 }).catch(() => {});
  const body = await page.evaluate("document.body.innerText");
  check("상태창에 현재 시즌 '여름 시즌' 표시", body.includes("여름 시즌"), body.split("\n").find((l) => l.includes("여름 시즌"))?.trim()?.slice(0, 90) ?? "(미발견)");
  check("상태창에 현재 주차 '1주차' 표시", /1\s*주차/.test(body), body.split("\n").find((l) => /1\s*주차/.test(l))?.trim()?.slice(0, 90) ?? "(미발견)");

  // 2) 같은 세션으로 in-page fetch → current-week API (브라우저 전 경로).
  const cw = await page.evaluate(async () => {
    const r = await fetch("/api/admin/cluster4/current-week", { cache: "no-store" });
    return r.json();
  });
  check("in-page current-week seasonKey=2026-summer", cw?.data?.seasonKey === "2026-summer", String(cw?.data?.seasonKey));
  check("in-page current-week weekNumber=1", cw?.data?.weekNumber === 1, String(cw?.data?.weekNumber));
  check("in-page current-week startDate=2026-06-29(월)", cw?.data?.startDate === "2026-06-29", String(cw?.data?.startDate));

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-week-boundary-0001.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-week-boundary-0001.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
} finally {
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
