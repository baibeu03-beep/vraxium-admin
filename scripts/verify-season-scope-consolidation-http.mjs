// 검증 — 현재 시즌 참여자 공통 헬퍼 통합: HTTP == direct (roster + week-recognitions) + 누수 0.
//   사전: admin dev :3000 실행 + scripts/.tmp-season-scope-direct.json (direct 스크립트 먼저 실행).
//   node scripts/verify-season-scope-consolidation-http.mjs
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
const eqArr = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const direct = JSON.parse(readFileSync(resolve(adminRoot, "scripts/.tmp-season-scope-direct.json"), "utf8"));

// auth → cookies
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

// ── 1) roster: 전 페이지 수집 ─────────────────────────────────────────────
hr(); console.log("▶ HTTP GET /api/admin/members/roster?mode=operating (전 페이지)");
const httpRosterIds = [];
let httpRosterCounts = null, httpRosterTotal = 0;
{
  let pageN = 1, filteredTotal = Infinity;
  while (httpRosterIds.length < filteredTotal) {
    const res = await page.request.get(`${BASE}/api/admin/members/roster?mode=operating&pageSize=200&page=${pageN}`);
    if (res.status() !== 200) { ck(`roster HTTP 200 (page ${pageN})`, false, `status=${res.status()}`); break; }
    const j = await res.json();
    const d = j.data ?? j;
    filteredTotal = d.filteredTotal;
    httpRosterTotal = d.total;
    httpRosterCounts = d.statusCounts;
    for (const m of d.members ?? []) httpRosterIds.push(m.userId);
    if ((d.members ?? []).length === 0) break;
    pageN++;
    if (pageN > 100) break;
  }
}
httpRosterIds.sort();
ck("roster member id 집합  direct == HTTP", eqArr(direct.rosterIds, httpRosterIds), `direct=${direct.rosterIds.length} http=${httpRosterIds.length}`);
ck("roster statusCounts  direct == HTTP", JSON.stringify(direct.rosterStatusCounts) === JSON.stringify(httpRosterCounts), JSON.stringify(httpRosterCounts));
ck("roster total  direct == HTTP", direct.rosterTotal === httpRosterTotal, `direct=${direct.rosterTotal} http=${httpRosterTotal}`);
const baseSet = new Set(direct.baselineIds);
ck("roster HTTP 누수 0 (전원 현재 시즌 참여자)", httpRosterIds.every((id) => baseSet.has(id)), `${httpRosterIds.filter((id) => !baseSet.has(id)).length}`);

// ── 2) week-recognitions ──────────────────────────────────────────────────
hr(); console.log("▶ HTTP GET /api/admin/week-recognitions");
const wrRes = await page.request.get(`${BASE}/api/admin/week-recognitions`);
ck("week-recognitions HTTP 200", wrRes.status() === 200, `status=${wrRes.status()}`);
const wrJson = await wrRes.json();
const wrData = wrJson.data ?? wrJson;
const wrRows = wrData.rows ?? [];
const httpWrUserIds = [...new Set(wrRows.map((r) => r.user_id))].sort();
ck("week-recognitions user_id 집합  direct == HTTP", eqArr(direct.wrUserIds, httpWrUserIds), `direct=${direct.wrUserIds.length} http=${httpWrUserIds.length}`);
ck("week-recognitions summary  direct == HTTP", JSON.stringify(direct.wrSummary) === JSON.stringify(wrData.summary), JSON.stringify(wrData.summary));
ck("week-recognitions row수  direct == HTTP", direct.wrRowCount === wrRows.length, `direct=${direct.wrRowCount} http=${wrRows.length}`);
ck("week-recognitions HTTP 누수 0 (전원 현재 시즌 참여자)", httpWrUserIds.every((id) => baseSet.has(id)), `${httpWrUserIds.filter((id) => !baseSet.has(id)).length}`);

// ── 3) 브라우저 반영 확인 (/admin/members 크루 목록 탭) ──────────────────────
hr(); console.log("▶ 브라우저 /admin/members?tab=roster — 모집단 카운트 반영");
await page.goto(`${BASE}/admin/members?tab=roster`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length > 0, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(1200);
const bodyText = await page.evaluate(() => document.body.innerText);
const hasParticipantCount = bodyText.includes(String(direct.rosterTotal));
ck(`브라우저에 모집단 수(${direct.rosterTotal}) 표기`, hasParticipantCount, hasParticipantCount ? "표기됨" : "미발견(렌더 표기 형식 차이 가능)");
await page.screenshot({ path: "claudedocs/season-scope-members-roster.png" });

await browser.close();
hr();
console.log(fail === 0 ? "✅ HTTP == DIRECT PASS (누수 0)" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
