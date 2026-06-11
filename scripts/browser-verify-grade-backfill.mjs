// 브라우저 검증 — 등급 보정 후 라인 관리 보드 파트장/에이전트 카운트 실제 렌더 확인.
//   /admin/line-opening/practical-experience?org=oranke & ?org=encre (라인 관리 탭)
//   각 팀 카드 HeadcountSummary 의 "파트장 N | 에이전트 N" 합산 → HTTP 결과와 대조 + 스크린샷.
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
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

const EXPECT = { oranke: { pl: 6, ag: 8 }, encre: { pl: 7, ag: 19 } };

for (const org of ["oranke", "encre"]) {
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${org}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  // 모든 "파트장 N | 에이전트 N" 라인을 읽어 합산.
  const text = await page.evaluate(() => document.body.innerText);
  let pl = 0, ag = 0;
  const re = /파트장\s+(\d+)\s*\|\s*에이전트\s+(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) { pl += Number(m[1]); ag += Number(m[2]); }
  check(`[${org}] 브라우저 보드 파트장 합 = ${EXPECT[org].pl}`, pl === EXPECT[org].pl, `렌더 파트장 ${pl}`);
  check(`[${org}] 브라우저 보드 에이전트 합 = ${EXPECT[org].ag}`, ag === EXPECT[org].ag, `렌더 에이전트 ${ag}`);
  await page.screenshot({ path: resolve(adminRoot, `claudedocs/browser-grade-backfill-${org}.png`), fullPage: true });
}

console.log(`\n=== 브라우저 검증 종료: PASS ${pass} / FAIL ${fail} ===`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
