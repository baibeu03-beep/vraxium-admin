// 검증 — /admin/members 모집단 318: HTTP roster == direct + 브라우저(전체318·시즌휴식50·중단66).
//   사전조건: admin :3000. node scripts/verify-summer-318-http-browser.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
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
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const hr = () => console.log("─".repeat(72));

// 코호트
async function ids(status) { const o = new Set(); for (let f = 0; ; f += 1000) { const { data } = await sb.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer").eq("status", status).order("user_id").range(f, f + 999); for (const r of data ?? []) o.add(r.user_id); if ((data ?? []).length < 1000) break; } return o; }
const rest = await ids("rest"), stopped = await ids("stopped"), active = await ids("active");

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

hr(); console.log("▶ HTTP GET /api/admin/members/roster?mode=operating");
const res = await page.request.get(`${BASE}/api/admin/members/roster?mode=operating`);
const j = await res.json();
const members = j.data?.members ?? j.members ?? [];
ck("HTTP 200", res.status() === 200);
ck("HTTP 모집단 = 318 (633 아님)", members.length === 318, `${members.length}`);
const byId = new Map(members.map((m) => [m.userId, m.displayGrowthStatus]));
ck("휴식50·중단66·active199 코호트 전원 명부 포함", [...rest, ...stopped, ...active].every((id) => byId.has(id)) && (rest.size + stopped.size + active.size) === 318);
const dist = {};
for (const m of members) dist[m.displayGrowthStatus ?? "?"] = (dist[m.displayGrowthStatus ?? "?"] ?? 0) + 1;
console.log(`  dist=${JSON.stringify(dist)}`);
ck("HTTP seasonal_rest=51", (dist.seasonal_rest ?? 0) === 51, `${dist.seasonal_rest}`);
ck("HTTP suspended=66", (dist.suspended ?? 0) === 66, `${dist.suspended}`);

hr(); console.log("▶ direct == HTTP");
ck("direct 코호트(201/51/66=318) == HTTP 모집단", members.length === 318 && active.size === 201 && rest.size === 51 && stopped.size === 66);

hr(); console.log("▶ 브라우저 /admin/members — 전체 모집단 + 상태 필터");
let rosterCount = -1;
const respP = page.waitForResponse((r) => r.url().includes("/api/admin/members/roster"), { timeout: 40000 }).catch(() => null);
await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
const resp = await respP;
if (resp) { try { const jj = await resp.json(); rosterCount = (jj.data?.members ?? jj.members ?? []).length; } catch {} }
await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 0, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1000);
console.log(`  브라우저가 로드한 roster 모집단(API) = ${rosterCount}`);
ck("브라우저 모집단 318", rosterCount === 318, `${rosterCount}`);

async function applyFilterAndCount(optionLabel) {
  const selects = page.locator("select"); const n = await selects.count();
  for (let i = 0; i < n; i++) { const opts = await selects.nth(i).locator("option").allTextContents(); if (opts.includes("활동 중단") || opts.includes("시즌 휴식")) { await selects.nth(i).selectOption({ label: optionLabel }); break; } }
  await page.getByRole("button", { name: "확인" }).first().click();
  await page.waitForTimeout(1300);
  return await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
}
const r1 = await applyFilterAndCount("시즌 휴식"); console.log(`  시즌 휴식 필터=${r1}`); ck("브라우저 시즌 휴식 51", r1 === 51, `${r1}`);
const r2 = await applyFilterAndCount("활동 중단"); console.log(`  활동 중단 필터=${r2}`); ck("브라우저 활동 중단 66", r2 === 66, `${r2}`);
await page.screenshot({ path: "claudedocs/members-318.png" });

await browser.close();
hr();
console.log(fail === 0 ? "✅ /admin/members 318 모집단 HTTP+BROWSER PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
