// 검증(브라우저) — /admin/team-parts/info/weeks 에서 전환 주차(0주차)가 UI 에 노출되지 않는지.
//   1) 각 org(encre/oranke/phalanx) 전 페이지 순회 → 주차명에 "- 0"(전환) 행이 없음
//   2) 현재 주차 배너에 "0주차" 문자열 없음(전환 자동선택/오분류 없음)
//   3) mode=test 결과도 동일(0주차 없음)
//   4) 회귀: /admin/periods/register 에는 전환 주차(0주차) 가 계속 노출됨
// read-only. 사전조건: admin dev :3000. Usage: node scripts/browser-verify-team-parts-info-weeks-transition.mjs
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

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// 세션 쿠키.
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
  name: i.name, value: i.value, domain: "localhost", path: "/",
  httpOnly: false, secure: false, sameSite: "Lax",
}));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 전환 주차 판정: 주차명이 "YY - 시즌 - 0" 형태(끝이 " - 0").
const isTransitionName = (name) => /-\s*0\s*$/.test(name.trim());

async function collectWeekNamesAllPages() {
  const names = [];
  for (let guard = 0; guard < 30; guard++) {
    await page.waitForSelector("[data-weeks-table]", { timeout: 15000 });
    const pageNames = await page.$$eval("[data-week-name]", (els) =>
      els.map((e) => e.textContent?.trim() ?? ""),
    );
    names.push(...pageNames);
    const nextBtn = await page.$("[data-page-next]");
    const disabled = nextBtn ? await nextBtn.isDisabled() : true;
    if (!nextBtn || disabled) break;
    await nextBtn.click();
    await page.waitForTimeout(600);
  }
  return names;
}

for (const org of ["encre", "oranke", "phalanx"]) {
  for (const mode of ["", "&mode=test"]) {
    const label = `${org}${mode ? "/test" : "/operating"}`;
    await page.goto(`${BASE}/admin/team-parts/info/weeks?club=${org}${mode}`, {
      waitUntil: "networkidle",
    });
    const names = await collectWeekNamesAllPages();
    const leaked = names.filter(isTransitionName);
    ck(`[${label}] 주차 목록에 0주차(전환) 행 없음 (총 ${names.length}행)`, leaked.length === 0, leaked.join(", "));

    // 현재 주차 배너에 "0주차" 문자열 없음.
    const banner = await page.$eval("[data-current-week]", (e) => e.textContent ?? "").catch(() => "");
    ck(`[${label}] 현재 주차 배너에 "0주차" 없음`, !/\b0주차\b/.test(banner), banner.replace(/\s+/g, " ").slice(0, 120));
  }
}

// ── 회귀: periods/register 에는 전환 주차(0주차) 계속 노출 ──
await page.goto(`${BASE}/admin/periods/register`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const registerText = await page.evaluate(() => document.body.innerText);
ck("[regression] /admin/periods/register 에 0주차(전환) 계속 노출",
  /0주차|전환/.test(registerText),
  registerText.match(/[^\n]*0주차[^\n]*/)?.[0]?.trim()?.slice(0, 80) ?? "(0주차 텍스트 미발견)");

await browser.close();
console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
