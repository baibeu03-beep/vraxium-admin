// 검증(브라우저) — TestModeToggle 표시/토글/지속/가드.
//   1) 최초 operating 진입 → 버튼 없음
//   2) ?mode=test 진입 → 버튼 표시
//   3) OFF 클릭 → mode 제거(operating)
//   4) ON 클릭 → mode=test 복구
//   5) org/tab query 유지
//   6) 다른 admin 페이지 이동 후에도 버튼 유지(localStorage seen)
//   7) 고객 앱 경로엔 미표시(admin 전용)
// read-only(백엔드/스코프/snapshot 무관 — URL query 만).
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com", ORG = "oranke";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 토글 버튼(텍스트 '테스트 모드') 찾기.
const toggle = () => page.evaluate(() =>
  [...document.querySelectorAll("button")].find((b) => /테스트 모드 (ON|OFF)/.test(b.textContent || "")) || null
);
const toggleText = async () => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /테스트 모드 (ON|OFF)/.test(x.textContent || ""));
  return b ? b.textContent.trim() : null;
});
const clickToggle = async () => page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /테스트 모드 (ON|OFF)/.test(x.textContent || ""));
  if (b) b.click();
  return !!b;
});
const goto = async (path) => { await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(1200); };

try {
  // ── 1) 최초 operating → 버튼 없음 (localStorage 비움 상태) ──
  await goto(`/admin/line-opening/practical-experience?org=${ORG}&tab=manage`);
  await page.evaluate(() => { try { localStorage.removeItem("vraxium.admin.testModeSeen"); } catch {} });
  await goto(`/admin/line-opening/practical-experience?org=${ORG}&tab=manage`);
  ck("[1] 최초 operating 진입 시 버튼 없음", (await toggleText()) === null);

  // ── 2) ?mode=test 진입 → 버튼 표시(ON) ──
  await goto(`/admin/line-opening/practical-experience?org=${ORG}&tab=manage&mode=test`);
  ck("[2] mode=test 진입 시 버튼 표시(ON)", (await toggleText()) === "테스트 모드 ON");

  // ── 3) OFF 클릭 → mode 제거 + org/tab 유지(#5) ──
  await clickToggle();
  await page.waitForTimeout(1000);
  const url3 = new URL(page.url());
  ck("[3] OFF 클릭 → mode 제거(operating)", url3.searchParams.get("mode") === null, url3.search);
  ck("[5] OFF 후 org/tab query 유지", url3.searchParams.get("org") === ORG && url3.searchParams.get("tab") === "manage", url3.search);
  // operating 이지만 seen=true 라 버튼은 계속 표시(OFF 라벨).
  ck("[3b] operating 복귀해도 버튼 유지(OFF 라벨)", (await toggleText()) === "테스트 모드 OFF");

  // ── 4) ON 클릭 → mode=test 복구 + query 유지 ──
  await clickToggle();
  await page.waitForTimeout(1000);
  const url4 = new URL(page.url());
  ck("[4] ON 클릭 → mode=test 복구", url4.searchParams.get("mode") === "test", url4.search);
  ck("[5] ON 후 org/tab query 유지", url4.searchParams.get("org") === ORG && url4.searchParams.get("tab") === "manage");
  ck("[4b] 버튼 라벨 ON", (await toggleText()) === "테스트 모드 ON");

  // ── 6) 다른 admin 페이지 이동(operating, mode 없음) 후에도 버튼 유지 ──
  await goto(`/admin/members?org=${ORG}`);
  ck("[6] 다른 admin 페이지(members, operating) 이동 후 버튼 유지", (await toggleText()) !== null, await toggleText());

  // ── 7) 고객 앱 경로(admin 아님) → 미표시 ──
  await goto(`/crews?org=${ORG}`);
  ck("[7] 고객 앱(/crews) 에는 버튼 미표시", (await toggleText()) === null);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-test-mode-toggle.png"), fullPage: false });
  console.log("  screenshot → claudedocs/browser-test-mode-toggle.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-test-mode-toggle-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
