// 검증(브라우저+HTTP) — 관리자별 허용 조직 게이트.
//   현재 admin_users 는 전부 owner(전체 허용)이므로, 여기서는 "전체 허용 관리자" 경로의
//   회귀(3 조직 탭/필터 모두 노출 · 모든 org GET 200)를 실제 브라우저·HTTP 로 확인한다.
//   (단일 조직 admin 의 탭 숨김/403 은 별도 org-scoped 계정이 필요 — 직접 SoT 검증
//    scripts/verify-admin-org-access.ts 15/15 로 커버.)
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-admin-org-access.mjs
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
const EMAIL = "vanuatu.golden@gmail.com"; // owner (전체 허용)

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
const body = () => page.evaluate(() => document.body.innerText);

// ── 1) 휴식 관리 — 3 조직 탭 노출 ──
console.log("\n▶ /admin/rest-management (owner=전체 허용)");
await page.goto(`${BASE}/admin/rest-management`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const rmBody = await body();
for (const label of ["엥크레", "오랑캐", "팔랑크스"]) ck(`탭 '${label}' 노출`, rmBody.includes(label));

// ── 2) 팀/파트 정보 — 3 조직 탭(data-org-tab) 노출 ──
//   조직 탭 섹션은 반기 팀 데이터 로드 후(!loading && halves>0) 렌더 → 탭 등장까지 대기.
console.log("\n▶ /admin/team-parts/info");
await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-org-tab]', { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(500);
const tabCount = await page.locator('[data-org-tab]').count();
if (tabCount === 0) {
  const tb = await body();
  ck("팀/파트 조직 탭 렌더", false, `탭 미표시 — 본문: ${tb.slice(0, 120).replace(/\n/g, " ")}`);
} else {
  for (const org of ["encre", "oranke", "phalanx"]) {
    const n = await page.locator(`[data-org-tab="${org}"]`).count();
    ck(`조직 탭 [data-org-tab="${org}"] 존재`, n >= 1, `${n}개`);
  }
}

// ── 3) 라인 정보 — 클럽 필터 옵션(엥크레/오랑캐/팔랑크스/공통) 노출 ──
console.log("\n▶ /admin/lines/info");
await page.goto(`${BASE}/admin/lines/info`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const clubOpts = await page.locator('select[aria-label="클럽 필터"] option').allInnerTexts().catch(() => []);
for (const label of ["엥크레", "오랑캐", "팔랑크스", "공통"]) ck(`클럽 필터 옵션 '${label}'`, clubOpts.includes(label), clubOpts.join("|"));

// ── 4) HTTP(GET) — owner 는 모든 org 200 (page.request = 세션 쿠키 사용) ──
console.log("\n▶ HTTP GET (owner, 모든 org 200 기대)");
const api = context.request;
async function status(path) { const r = await api.get(`${BASE}${path}`); return r.status(); }
for (const org of ["encre", "oranke", "phalanx"]) {
  ck(`GET rest-management/summary?organization=${org} → 200`, (await status(`/api/admin/rest-management/summary?organization=${org}`)) === 200);
}
for (const org of ["encre", "oranke", "phalanx"]) {
  ck(`GET team-parts/info?organization=${org} → 200`, (await status(`/api/admin/team-parts/info?organization=${org}`)) === 200);
}
ck(`GET lines/registrations?hub=info → 200`, (await status(`/api/admin/lines/registrations?hub=info&limit=5`)) === 200);
ck(`GET lines/registrations?hub=info&organization=oranke → 200 (owner)`, (await status(`/api/admin/lines/registrations?hub=info&organization=oranke&limit=5`)) === 200);

await page.screenshot({ path: "claudedocs/admin-org-access-owner-lines.png" }).catch(() => {});
await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
