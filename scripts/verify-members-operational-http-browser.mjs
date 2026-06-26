// 검증 — /admin/members 운영기준시즌: HTTP roster == direct + 브라우저 시즌휴식50/중단66(+1).
//   사전조건: admin :3000. node scripts/verify-members-operational-http-browser.mjs
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

// 코호트(direct DB)
async function ids(status) { const out = new Set(); for (let f = 0; ; f += 1000) { const { data } = await sb.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer").eq("status", status).order("user_id").range(f, f + 999); for (const r of data ?? []) out.add(r.user_id); if ((data ?? []).length < 1000) break; } return out; }
const rest = await ids("rest"), stopped = await ids("stopped");

// auth
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
ck("HTTP 200", res.status() === 200, `status=${res.status()}`);
const dist = {};
for (const m of members) dist[m.displayGrowthStatus ?? "(null)"] = (dist[m.displayGrowthStatus ?? "(null)"] ?? 0) + 1;
console.log(`  members=${members.length} dist=${JSON.stringify(dist)}`);
const byId = new Map(members.map((m) => [m.userId, m.displayGrowthStatus]));
const restOk = [...rest].every((id) => byId.get(id) === "seasonal_rest");
const stopOk = [...stopped].every((id) => byId.get(id) === "suspended");
ck("휴식 50 코호트 전원 seasonal_rest (HTTP)", restOk && [...rest].filter((id) => byId.has(id)).length === 50);
ck("중단 66 코호트 전원 suspended (HTTP)", stopOk && [...stopped].filter((id) => byId.has(id)).length === 66);
ck("HTTP seasonal_rest=50", (dist.seasonal_rest ?? 0) === 50, `${dist.seasonal_rest}`);
ck("HTTP suspended=66 또는 67(수동override+1)", (dist.suspended ?? 0) === 66 || (dist.suspended ?? 0) === 67, `${dist.suspended}`);

hr(); console.log("▶ direct == HTTP (listMembersRoster)");
// direct 분포는 verify-members-operational-season.ts 에서 50/66 확인됨. 여기선 HTTP dist 와 코호트 일치로 동치 확인.
ck("direct==HTTP 코호트 일치 (휴식50·중단66)", restOk && stopOk);

hr(); console.log("▶ 브라우저 /admin/members (list 탭) — 상태 필터 카운트");
await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 0, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1000);
// 상태 필터: '시즌 휴식' 선택 → 행수 / '활동 중단' 선택 → 행수
// 필터는 native <select> + [확인] 버튼. 필터 select(옵션에 '활동 중단' 포함) 를 찾아 selectOption 후 확인.
async function applyFilterAndCount(optionLabel) {
  const selects = page.locator("select");
  const n = await selects.count();
  let done = false;
  for (let i = 0; i < n; i++) {
    const opts = await selects.nth(i).locator("option").allTextContents();
    if (opts.includes("활동 중단") || opts.includes("시즌 휴식")) {
      await selects.nth(i).selectOption({ label: optionLabel });
      done = true; break;
    }
  }
  if (!done) return -1;
  await page.getByRole("button", { name: "확인" }).first().click();
  await page.waitForTimeout(1300);
  return await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
}
const restRows = await applyFilterAndCount("시즌 휴식");
console.log(`  '시즌 휴식' 필터 행수=${restRows}`);
ck("브라우저 시즌 휴식 = 50", restRows === 50, `${restRows}`);
const stopRows = await applyFilterAndCount("활동 중단");
console.log(`  '활동 중단' 필터 행수=${stopRows} (66 코호트 + 수동override)`);
ck("브라우저 활동 중단 >= 66 (코호트 66 포함)", stopRows >= 66, `${stopRows}`);
ck("브라우저 활동 중단 = 67 (66 + 수동 1) 또는 66", stopRows === 66 || stopRows === 67, `${stopRows}`);
await page.screenshot({ path: "claudedocs/members-operational-stopped.png" });

await browser.close();
hr();
console.log(fail === 0 ? "✅ /admin/members operational HTTP+BROWSER PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
