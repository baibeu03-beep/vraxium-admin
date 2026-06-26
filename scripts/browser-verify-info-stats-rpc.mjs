// 검증(브라우저) — RPC 적용 후 4탭: "스냅샷 미조회" 경고 없음 + Po 정상 렌더.
//   Usage: node scripts/browser-verify-info-stats-rpc.mjs
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
const waitDto = (org) => page.waitForResponse((r) => r.url().includes("/api/admin/members/info-stats") && (org === "all" ? !r.url().includes("organization=") : r.url().includes(`organization=${org}`)), { timeout: 60000 }).then((r) => r.json()).then((j) => j.data);

await page.goto(`${BASE}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("Oldest"), { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(400);
let b = await body();
ck("[통합] 미조회 경고 없음", !b.includes("스냅샷 미조회"));

for (const t of [{ l: "엥크레", o: "encre" }, { l: "오랑캐", o: "oranke" }, { l: "팔랑크스", o: "phalanx" }]) {
  const p = waitDto(t.o);
  await page.getByRole("button", { name: t.l, exact: true }).click();
  const dto = await p;
  const ff = (dto.weeks ?? []).find((w) => w.finalized && w.weeklyTopPoints?.length);
  await page.waitForFunction((n) => document.body.innerText.includes(n) && document.body.innerText.includes("Po.A"), ff ? ff.seasonWeekName : "Po.A", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(500);
  b = await body();
  ck(`[${t.l}] 미조회 경고 없음`, !b.includes("스냅샷 미조회"));
  ck(`[${t.l}] partialFailure 0`, (dto.partialFailure?.snapshotUnavailable ?? 0) === 0);
  if (ff) { const a = ff.weeklyTopPoints[0]; ck(`[${t.l}] Po.A '${a.name} 님 (${a.points}개)' 렌더`, b.includes(`${a.name} 님 (${a.points}개)`)); }
}
await page.screenshot({ path: "claudedocs/members-info-rpc-fixed.png" });
await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
