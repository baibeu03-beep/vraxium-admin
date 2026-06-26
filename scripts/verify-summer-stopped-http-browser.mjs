// 검증 — 2026-summer stopped: HTTP==direct + 브라우저(/admin/season-participations 중단 필터=66) + 고객 weekly-growth 게이팅.
//   사전조건: admin :3000, 고객 :3001. node scripts/verify-summer-stopped-http-browser.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const { chromium } = createRequire(resolve(adminRoot, "..", "vraxium", "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000", CUST = "http://localhost:3001";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const hr = () => console.log("─".repeat(72));
const EXPECT = 66;

// auth
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

hr(); console.log("▶ HTTP GET season-participations?season_key=2026-summer&status=stopped");
const res = await page.request.get(`${BASE}/api/admin/season-participations?season_key=2026-summer&status=stopped`);
const j = await res.json();
const rows = j.data?.rows ?? [];
const perOrg = {};
for (const r of rows) perOrg[r.organization_slug ?? "?"] = (perOrg[r.organization_slug ?? "?"] ?? 0) + 1;
console.log(`  HTTP rows=${rows.length} stopped_count=${j.data?.summary?.stopped_count} perOrg=${JSON.stringify(perOrg)}`);
ck("HTTP 200", res.status() === 200 && j.success);
ck(`HTTP rows=${EXPECT}`, rows.length === EXPECT, `${rows.length}`);
ck(`HTTP stopped_count=${EXPECT}`, j.data?.summary?.stopped_count === EXPECT);
ck("HTTP encre37/oranke21/phalanx8", perOrg.encre === 37 && perOrg.oranke === 21 && perOrg.phalanx === 8, JSON.stringify(perOrg));
ck("전부 status=stopped & season=2026-summer", rows.every((r) => r.status === "stopped" && r.season_key === "2026-summer"));

// direct (DB user_season_statuses 직접) == HTTP user_id 집합
const directIds = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer").eq("status", "stopped").order("user_id").range(from, from + 999);
  for (const r of data ?? []) directIds.push(r.user_id);
  if ((data ?? []).length < 1000) break;
}
const httpIds = rows.map((r) => r.user_id).sort();
ck("direct==HTTP (count)", directIds.length === rows.length, `${directIds.length} vs ${rows.length}`);
ck("direct==HTTP (user_id 집합)", JSON.stringify([...directIds].sort()) === JSON.stringify(httpIds));

hr(); console.log("▶ 브라우저 /admin/season-participations (여름+중단 필터)");
await page.goto(`${BASE}/admin/season-participations`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 0 || document.body.innerText.includes("조회된 시즌"), { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(600);
const triggers = page.locator('button[role="combobox"]');
await triggers.nth(0).click(); await page.waitForTimeout(400);
await page.getByRole("option", { name: "2026년도 여름시즌", exact: true }).click(); await page.waitForTimeout(500);
await triggers.nth(2).click(); await page.waitForTimeout(400);
await page.getByRole("option", { name: "중단", exact: true }).first().click();
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForFunction((n) => document.querySelectorAll("table tbody tr").length === n && !document.body.innerText.includes("불러오는 중"), EXPECT, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(500);
const rowCount = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
const stoppedCard = await page.evaluate(() => {
  const labs = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent?.trim() === "중단");
  for (const lab of labs) { const card = lab.closest("div")?.parentElement; if (!card) continue; const nums = [...card.querySelectorAll("*")].map((e) => e.textContent?.trim()).filter((x) => x && /^\d+$/.test(x)); if (nums.length) return nums[0]; }
  return null;
});
console.log(`  table rows=${rowCount} 중단카드≈${stoppedCard}`);
ck(`표 ${EXPECT}행`, rowCount === EXPECT, `${rowCount}`);
ck(`중단 요약카드=${EXPECT}`, String(stoppedCard) === String(EXPECT), `card=${stoppedCard}`);
await page.screenshot({ path: "claudedocs/summer-stopped-season-participations.png" });

hr(); console.log("▶ 고객 weekly-growth 게이팅 (오늘=봄 → 중단 미표시, 정상)");
const { data: jhs } = await sb.from("user_profiles").select("user_id").eq("organization_slug","encre").eq("display_name","최지영").limit(1).maybeSingle();
const r2 = await fetch(`${CUST}/api/cluster4/weekly-growth?userId=${jhs.user_id}`);
const jj = await r2.json();
const label = jj?.data?.seasonSummary?.statusLabel;
console.log(`  최지영(중단대상) 고객 현재시즌 statusLabel="${label}" (오늘 봄 → 진행중 기대·여름전환시 중단)`);
ck("오늘 중단대상도 현재시즌(봄) 라벨은 중단 아님(게이팅)", label !== "시즌 중단", `label=${label}`);

await browser.close();
hr();
console.log(fail === 0 ? "✅ stopped HTTP+BROWSER 검증 ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
