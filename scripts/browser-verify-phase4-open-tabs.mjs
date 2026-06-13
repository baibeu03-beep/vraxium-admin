// 검증(브라우저) — Phase 4: 실무 경험 open 탭 팀 탭 mode 분리.
//   브라우저가 보낸 /cluster4/teams 응답 캡처로 검증(컴포넌트가 mode 전파 + 탭 데이터).
//   operating(?org=oranke&tab=open) → (T) 팀 탭 미노출. test(&mode=test) → (T) 팀만.
//   read-only. snapshot 무접촉.
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
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(cookies);
const page = await context.newPage();

let lastTeams = null;
page.on("response", async (res) => {
  if (/\/api\/admin\/cluster4\/teams(\?|$)/.test(res.url())) {
    try { lastTeams = { url: res.url(), data: (await res.json()).data }; } catch {/* skip */}
  }
});
async function gotoCapture(url, waitForText) {
  lastTeams = null;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30 && !lastTeams; i++) await page.waitForTimeout(500);
  // 팀 탭(파트장 입력 카드)이 실제로 렌더될 때까지 대기.
  if (waitForText) {
    await page.waitForFunction(
      (t) => [...document.querySelectorAll("button")].some((b) => (b.textContent || "").trim() === t),
      waitForText,
      { timeout: 15000 },
    ).catch(() => {});
  }
  await page.waitForTimeout(500);
  return lastTeams;
}
// open 탭에 렌더된 팀 탭 버튼 텍스트(정확히 팀명과 일치하는 버튼만).
const tabButtons = (names) => page.evaluate((names) => {
  const set = new Set(names);
  return [...document.querySelectorAll("button")].map((b) => (b.textContent || "").trim()).filter((t) => set.has(t));
}, names);

try {
  // ── operating open 탭 ──
  const op = await gotoCapture(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open`, "F&B");
  ck("[operating] teams 호출 캡처", !!op, op?.url);
  ck("[operating] teams 요청에 mode=test 없음", !!op && !op.url.includes("mode=test"));
  const opNames = (op?.data ?? []).map((t) => t.teamName);
  ck("[operating] teams 응답에 (T) 0개", !opNames.some((t) => /\(T\)$/.test(t)), `teams=${opNames.join(",")}`);
  const allNames = [...opNames, "과일(T)", "음료(T)", "콘텐츠실험(T)"];
  const opTabs = await tabButtons(allNames);
  ck("[operating] open 탭 팀 탭: 운영 팀 노출·(T) 미노출",
    opTabs.includes("F&B") && !opTabs.some((t) => /\(T\)$/.test(t)), `tabs=${opTabs.join(",")}`);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phase4-operating-open.png"), fullPage: true });

  // ── test open 탭 ──
  const ts = await gotoCapture(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&tab=open&mode=test`, "과일(T)");
  ck("[test] teams 요청에 mode=test 전파", !!ts && ts.url.includes("mode=test"), ts?.url);
  const tsNames = (ts?.data ?? []).map((t) => t.teamName);
  ck("[test] teams 응답 = (T) 3개", tsNames.length === 3 && tsNames.every((t) => /\(T\)$/.test(t)), `teams=${tsNames.join(",")}`);
  const tsTabs = await tabButtons(allNames);
  ck("[test] open 탭 팀 탭 = (T)만 노출(운영 팀 없음)",
    tsTabs.length > 0 && tsTabs.every((t) => /\(T\)$/.test(t)) && !tsTabs.includes("F&B"), `tabs=${tsTabs.join(",")}`);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phase4-test-open.png"), fullPage: true });

  console.log("  screenshots → claudedocs/browser-phase4-{operating,test}-open.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phase4-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
