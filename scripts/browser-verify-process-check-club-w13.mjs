// 검증(브라우저) — /admin/processes/check/club 테스트 W13 예외 실제 활성화.
//   test 모드: "13주차" 노출 + 체크 신청 버튼 enabled + 클릭 시 모달 오픈.
//   operating 모드: "16주차"(현재) 노출(W13 미노출) — 회귀 가드.
//   read-only 검증(write 안 함). 사전조건: admin dev :3000.
//   Usage: node scripts/browser-verify-process-check-club-w13.mjs
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

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

// ── test 모드: W13 노출 + 버튼 활성 + 모달 오픈 ──
await page.goto(`${BASE}/admin/processes/check/club?org=encre&mode=test`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("주차"), { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(800);
const tBody = await page.evaluate(() => document.body.innerText);
ck("[test] '13주차' 노출", tBody.includes("13주차"), tBody.match(/\d+주차/)?.[0] ?? "주차표기 없음");
ck("[test] '16주차' 미노출(예외가 W13 으로 폴드)", !tBody.includes("16주차"));

// 체크 대상 액트의 상태 버튼(신청/취소) 중 enabled 인 것 존재.
const btn = page
  .locator('button[title="클릭하여 체크 신청/취소"]')
  .first();
const btnCount = await page.locator('button[title="클릭하여 체크 신청/취소"]').count();
const disabledCount = await page.locator('button[title="현재 주차 weeks 행 없음"]').count();
ck("[test] 체크 버튼 enabled(disabled 0)", btnCount >= 1 && disabledCount === 0, `enabled=${btnCount} disabled=${disabledCount}`);

// 클릭 → 모달(다이얼로그) 오픈.
let modalOpened = false;
if (btnCount >= 1) {
  await btn.click().catch(() => {});
  await page.waitForTimeout(500);
  modalOpened = await page.evaluate(
    () => !!document.querySelector('[role="dialog"]') || document.body.innerText.includes("체크 신청"),
  );
}
ck("[test] 버튼 클릭 → 모달 오픈", modalOpened);

// ── operating 모드: W16(현재) 노출 · W13 미노출 ──
await page.goto(`${BASE}/admin/processes/check/club?org=encre&mode=operating`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("주차"), { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(800);
const oBody = await page.evaluate(() => document.body.innerText);
ck("[operating] '16주차'(현재) 노출 · '13주차' 미노출", oBody.includes("16주차") && !oBody.includes("13주차"), oBody.match(/\d+주차/)?.[0] ?? "주차표기 없음");

await browser.close();
console.log(`\n결과: ${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
process.exit(fail > 0 ? 1 : 0);
