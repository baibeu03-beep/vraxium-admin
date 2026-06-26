// 검증(브라우저) — /admin/members?tab=info 오랑캐·팔랑크스 탭: 데이터 시작·엘리트 "-"·Po.A/B/C("이름 님 (N개)").
//   각 탭(오랑캐/팔랑크스): 누적 라벨·Po.A/B/C 헤더·최신 Po 보유 주차 Po.A 신형식 렌더(페이지 받은 DTO 기준)
// read-only · snapshot 무관. 사전조건: admin dev :3000.
//   Usage: node scripts/browser-verify-club-info-stats.mjs
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
const waitDto = (org) => page.waitForResponse((r) => r.url().includes("/api/admin/members/info-stats") && r.url().includes(`organization=${org}`), { timeout: 180000 }).then((r) => r.json()).then((j) => j.data);

// 통합 먼저 로드(default·hydrate 보장)
await page.goto(`${BASE}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("Oldest"), { timeout: 180000 }).catch(() => {});
await page.waitForTimeout(400);

for (const t of [{ label: "오랑캐", org: "oranke" }, { label: "팔랑크스", org: "phalanx" }]) {
  console.log(`\n▶ ${t.label} 탭`);
  const p = waitDto(t.org);
  await page.getByRole("button", { name: t.label, exact: true }).click();
  const dto = await p;
  const ff = (dto.weeks ?? []).find((w) => w.finalized && w.weeklyTopPoints && w.weeklyTopPoints.length > 0);
  await page.waitForFunction((n) => document.body.innerText.includes(n) && document.body.innerText.includes("Po.A"),
    ff ? ff.seasonWeekName : "Po.A", { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(500);
  const b = await body();
  ck(`[${t.label}] 누적 '데이터 시작'`, b.includes("데이터 시작"));
  ck(`[${t.label}] 데이터 시작 값`, dto.cumulative.dataStartWeekLabel == null || b.includes(dto.cumulative.dataStartWeekLabel));
  ck(`[${t.label}] 누적 클러빙 값 ${dto.cumulative.cumulativeClubbing}`, b.includes(dto.cumulative.cumulativeClubbing.toLocaleString("en-US")));
  for (const h of ["Po.A", "Po.B", "Po.C"]) ck(`[${t.label}] 표 헤더 '${h}'`, b.includes(h));
  if (ff) {
    const a = ff.weeklyTopPoints[0];
    ck(`[${t.label}] Po.A '${a.name} 님 (${a.points}개)' 렌더`, b.includes(`${a.name} 님 (${a.points}개)`));
  }
  await page.screenshot({ path: `claudedocs/members-info-${t.org}-po.png` });
}

await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
