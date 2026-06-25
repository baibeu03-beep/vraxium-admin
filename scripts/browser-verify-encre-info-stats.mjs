// 검증(브라우저) — /admin/members?tab=info 엥크레 탭: 데이터 시작·엘리트("-")·Po.A/B/C 컬럼.
//   A) 엥크레 누적: 데이터 시작 주차명 · 누적 엘리트 "-" · 누적 클러빙 값
//   B) 주차별 표 우측 Po.A/B/C 헤더 + 최신 Po 보유 주차 Po.A "이름 NP" 렌더(페이지가 받은 DTO 기준)
//   C) 통합 탭에는 Po.A/B/C 컬럼 미노출
//   D) 스크린샷 저장
// read-only · snapshot 무관. 사전조건: admin dev :3000.
//   Usage: node scripts/browser-verify-encre-info-stats.mjs
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

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1750, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();
const body = () => page.evaluate(() => document.body.innerText);
const waitDto = (org) => page.waitForResponse(
  (r) => r.url().includes("/api/admin/members/info-stats") && (org === "all" ? !r.url().includes("organization=") : r.url().includes(`organization=${org}`)),
  { timeout: 180000 }).then((r) => r.json()).then((j) => j.data);

// ── 통합 먼저 로드(default 탭) → Po 미노출 확인 ──
console.log("▶ 통합 탭(default 로드 · Po 미노출)");
const allP = waitDto("all");
await page.goto(`${BASE}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("역대 누적"), { timeout: 60000 }).catch(() => {});
const all = await allP;
const allFf = (all.weeks ?? []).find((w) => w.finalized);
await page.waitForFunction((n) => document.body.innerText.includes(n) && document.body.innerText.includes("Oldest"),
  allFf ? allFf.seasonWeekName : "Oldest", { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(400);
let b = await body();
ck("통합 탭 표 헤더 'Po.A' 미노출", !b.includes("Po.A"));
ck("통합 탭 '클럽 수' 누적 노출", b.includes("클럽 수"));

// ── 엥크레 탭 클릭(페이지 hydrated 이후) ──
console.log("\n▶ 엥크레 탭");
const enP = waitDto("encre");
await page.getByRole("button", { name: "엥크레", exact: true }).click();
const en = await enP;
const ff = (en.weeks ?? []).find((w) => w.finalized && w.weeklyTopPoints && w.weeklyTopPoints.length > 0);
await page.waitForFunction((n) => document.body.innerText.includes(n) && document.body.innerText.includes("Po.A"),
  ff ? ff.seasonWeekName : "Po.A", { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(500);
b = await body();

// A) 누적
ck("누적 라벨 '데이터 시작'", b.includes("데이터 시작"));
ck("데이터 시작 값 렌더", en.cumulative.dataStartWeekLabel == null || b.includes(en.cumulative.dataStartWeekLabel));
ck("누적 클러빙 값", b.includes(en.cumulative.cumulativeClubbing.toLocaleString("en-US")));
ck("누적 엘리트 라벨", b.includes("누적 엘리트"));

// B) Po.A/B/C 헤더 + 값
for (const h of ["Po.A", "Po.B", "Po.C"]) ck(`표 헤더 '${h}'`, b.includes(h));
if (ff) {
  const a = ff.weeklyTopPoints[0];
  ck(`[${ff.seasonWeekName}] Po.A '${a.name} ${a.points}P' 렌더`, b.includes(`${a.name} ${a.points}P`));
}

// C) 스크린샷(엥크레)
await page.waitForTimeout(300);
await page.screenshot({ path: "claudedocs/members-info-encre-po.png" });

await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
