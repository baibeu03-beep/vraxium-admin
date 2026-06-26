// 검증 — 2026-summer 휴식: HTTP API == direct 함수, + 브라우저 렌더(어드민 페이지).
//   사전조건: admin dev :3000. Usage: node scripts/verify-summer-rest-http-browser.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const hr = () => console.log("─".repeat(72));
const EXPECT = Number(process.argv[2] || 49); // 동명이인 5 추가 후 49, 전현성까지 50
console.log(`(기대 총원 EXPECT=${EXPECT})`);

// ── direct 함수 결과(JSON) ──
console.log("▶ direct getSeasonParticipations(2026-summer, rest)");
const directRaw = execFileSync("npx", ["tsx", "--env-file=.env.local", "scripts/print-summer-rest-direct.ts"], { cwd: adminRoot, encoding: "utf8", shell: true });
const direct = JSON.parse(directRaw.trim().split("\n").pop());
console.log(`  direct: count=${direct.count} perOrg=${JSON.stringify(direct.perOrg)}`);
ck(`direct count=${EXPECT}`, direct.count === EXPECT, `${direct.count}`);

// ── 인증 ──
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

// ── HTTP API (인증 컨텍스트) ──
hr(); console.log("▶ HTTP GET /api/admin/season-participations?season_key=2026-summer&status=rest");
const res = await page.request.get(`${BASE}/api/admin/season-participations?season_key=2026-summer&status=rest`);
const j = await res.json();
ck("HTTP 200 success", res.status() === 200 && j.success === true, `status=${res.status()}`);
const rows = j.data?.rows ?? [];
const httpPerOrg = {};
for (const r of rows) httpPerOrg[r.organization_slug ?? "(null)"] = (httpPerOrg[r.organization_slug ?? "(null)"] ?? 0) + 1;
console.log(`  HTTP: rows=${rows.length} rest_count=${j.data?.summary?.rest_count} perOrg=${JSON.stringify(httpPerOrg)}`);
ck(`HTTP rows=${EXPECT}`, rows.length === EXPECT, `${rows.length}`);
ck(`HTTP summary.rest_count=${EXPECT}`, j.data?.summary?.rest_count === EXPECT, `${j.data?.summary?.rest_count}`);
ck("HTTP perOrg == direct perOrg", JSON.stringify(httpPerOrg) === JSON.stringify(direct.perOrg), `http=${JSON.stringify(httpPerOrg)} direct=${JSON.stringify(direct.perOrg)}`);
ck("HTTP 전부 status=rest & season=2026-summer", rows.every((r) => r.status === "rest" && r.season_key === "2026-summer"));

// ── direct == HTTP (user_id 집합 동일) ──
hr(); console.log("▶ direct == HTTP 동치");
const directIds = new Set(direct.names.map((n) => n.user_id));
const httpIds = new Set(rows.map((r) => r.user_id));
const sameSet = directIds.size === httpIds.size && [...directIds].every((id) => httpIds.has(id));
ck("direct user_id 집합 == HTTP user_id 집합", sameSet, `direct=${directIds.size} http=${httpIds.size}`);
ck("count 동일", direct.count === rows.length, `${direct.count} vs ${rows.length}`);
ck("perOrg 동일", JSON.stringify(direct.perOrg) === JSON.stringify(httpPerOrg));

// ── 다른 시즌(봄) HTTP — 여름44 와 다른 모집단(스코프 격리) ──
hr(); console.log("▶ 시즌 스코프 격리 — 봄 휴식 HTTP");
const resSpring = await page.request.get(`${BASE}/api/admin/season-participations?season_key=2026-spring&status=rest`);
const jSpring = await resSpring.json();
ck("봄 휴식 = 365 (여름과 별개 모집단)", jSpring.data?.summary?.rest_count === 365, `${jSpring.data?.summary?.rest_count}`);

// ── 브라우저 렌더(Radix select 조작) ──
hr(); console.log("▶ /admin/season-participations 브라우저 렌더 (여름+휴식 필터)");
await page.goto(`${BASE}/admin/season-participations`, { waitUntil: "domcontentloaded" });
// 초기 무필터 로드가 완료되어 시즌 드롭다운이 채워질 때까지 대기(행 또는 빈 메시지).
await page.waitForFunction(() => {
  const t = document.body.innerText;
  return document.querySelectorAll("table tbody tr").length > 0 || t.includes("조회된 시즌");
}, { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(600);
// 시즌 select → 2026년도 여름시즌 (정확 일치)
const triggers = page.locator('button[role="combobox"]');
await triggers.nth(0).click();
await page.waitForTimeout(400);
await page.getByRole("option", { name: "2026년도 여름시즌", exact: true }).click();
await page.waitForTimeout(500);
// 상태 select → 휴식 (세 번째 트리거: 시즌/조직/상태 순)
await triggers.nth(2).click();
await page.waitForTimeout(400);
await page.getByRole("option", { name: "휴식", exact: true }).first().click();
// 재조회 정착 대기: 표 행 == EXPECT 이고 요약 '휴식' 카드가 숫자로 채워질 때까지.
await page.waitForLoadState("networkidle").catch(() => {});
await page.waitForFunction((n) => {
  const rows = document.querySelectorAll("table tbody tr").length;
  const t = document.body.innerText;
  return rows === n && !t.includes("불러오는 중");
}, EXPECT, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(500);
const bodyText = await page.evaluate(() => document.body.innerText);
const rowCount = await page.evaluate(() => document.querySelectorAll("table tbody tr").length);
// 휴식 summary 카드 값 추출 — '휴식' 라벨 카드의 형제 숫자(라벨 텍스트 '여름시즌' 등 오인 방지).
const restCardVal = await page.evaluate(() => {
  const labels = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && e.textContent?.trim() === "휴식");
  for (const lab of labels) {
    // 요약 카드: 라벨과 큰 숫자가 같은 카드 컨테이너 안. 위/형제에서 순수 숫자 텍스트 탐색.
    const card = lab.closest("div")?.parentElement;
    if (!card) continue;
    const nums = [...card.querySelectorAll("*")].map((e) => e.textContent?.trim()).filter((x) => x && /^\d+$/.test(x));
    if (nums.length) return nums[0];
  }
  return null;
});
console.log(`  table rows=${rowCount} 휴식카드≈${restCardVal}`);
ck(`표에 ${EXPECT}행 렌더`, rowCount === EXPECT, `rows=${rowCount}`);
ck(`휴식 요약카드=${EXPECT}`, String(restCardVal) === String(EXPECT), `card=${restCardVal}`);
ck("여름 시즌 라벨 표시", bodyText.includes("여름시즌") || bodyText.includes("여름 시즌"));
ck("로딩 해제(불러오는 중 없음)", !bodyText.includes("불러오는 중"));
await page.screenshot({ path: "claudedocs/summer-rest-season-participations.png", fullPage: false });
console.log("  스크린샷 → claudedocs/summer-rest-season-participations.png");

await browser.close();
hr();
console.log(fail === 0 ? "✅ HTTP+BROWSER 검증 ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
