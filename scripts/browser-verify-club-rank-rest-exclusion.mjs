// 브라우저 검증 — seasonal_rest 모집단 제외가 admin 품계 노출 경로에 실제 반영되는지.
//   1) admin 로그인(magiclink) → 인증 컨텍스트
//   2) admin 품계 API GET /api/admin/crews/{userId}/cluster3/growth/rank
//      - rest 사용자 → avgPercentile=null, rankGrade=null
//      - active 사용자 → 품계 존재
//   3) /admin/members 페이지 실제 렌더(품계 컬럼) 확인
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-club-rank-rest-exclusion.mjs
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
const EMAIL = "vanuatu.golden@gmail.com";

const REST = "db6a6135-1508-450b-885b-48a8e49737a1"; // 강민주(seasonal_rest)
const ACTIVE = "017ef342-98e0-40bc-8eaf-9bd8ddd46653"; // active, 직접 계산 정5품/54

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

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

console.log("▶ admin 품계 API (인증 브라우저 컨텍스트)");
const rankOf = async (uid) => {
  const res = await page.request.get(`${BASE}/api/admin/crews/${uid}/cluster3/growth/rank`);
  const j = await res.json();
  return { status: res.status(), ...(j.data || {}), raw: j };
};
const r = await rankOf(REST);
ck(`rest 사용자 admin API 200`, r.status === 200, `status=${r.status}`);
ck(`rest 사용자 avgPercentile=null (모집단 제외)`, r.avgPercentile === null, `avg=${r.avgPercentile}`);
ck(`rest 사용자 rankGrade=null`, r.rankGrade === null, `grade=${r.rankGrade}`);
ck(`rest 사용자 weeklyDetails 비어있음`, Array.isArray(r.weeklyDetails) && r.weeklyDetails.length === 0, `len=${r.weeklyDetails?.length}`);
const a = await rankOf(ACTIVE);
ck(`active 사용자 품계 존재`, a.rankGrade !== null && a.avgPercentile !== null, `avg=${a.avgPercentile} grade=${a.rankGrade}`);

console.log("▶ /admin/members 페이지 실제 렌더");
await page.goto(`${BASE}/admin/members`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => { const t = document.body.innerText; return t.includes("품계") && !t.includes("불러오는 중..."); }, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(800);
const body = await page.evaluate(() => document.body.innerText);
const rowCount = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
ck("품계 컬럼 렌더", body.includes("품계"));
ck("로딩 해제 + 행 렌더(>0)", !body.includes("불러오는 중...") && rowCount > 0, `rows=${rowCount}`);

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
