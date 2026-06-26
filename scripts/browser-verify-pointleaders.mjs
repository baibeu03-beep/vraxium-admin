// 검증(브라우저) — Po.A/B/C 가 종류별 1위 크루 "이름 님 (N개)" 로 표시되는지(각 컬럼 다른 크루 가능).
//   Usage: node scripts/browser-verify-pointleaders.mjs
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
const waitDto = (org) => page.waitForResponse((r) => r.url().includes("/api/admin/members/info-stats") && r.url().includes(`organization=${org}`), { timeout: 120000 }).then((r) => r.json()).then((j) => j.data);

await page.goto(`${BASE}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.innerText.includes("Oldest"), { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(400);

for (const t of [{ l: "엥크레", o: "encre" }, { l: "오랑캐", o: "oranke" }]) {
  console.log(`\n▶ ${t.l} 탭`);
  const p = waitDto(t.o);
  await page.getByRole("button", { name: t.l, exact: true }).click();
  const dto = await p;
  // poB·poC 둘 다 있는 주차(3종 다른 크루 확인 가능) 우선.
  const w = (dto.weeks ?? []).find((x) => x.finalized && x.weeklyPointLeaders && x.weeklyPointLeaders.poA && x.weeklyPointLeaders.poB && x.weeklyPointLeaders.poC)
    || (dto.weeks ?? []).find((x) => x.finalized && x.weeklyPointLeaders && x.weeklyPointLeaders.poA);
  await page.waitForFunction((n) => document.body.innerText.includes(n) && document.body.innerText.includes("Po.A"), w ? w.seasonWeekName : "Po.A", { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(500);
  const b = await body();
  for (const h of ["Po.A", "Po.B", "Po.C"]) ck(`[${t.l}] 헤더 '${h}'`, b.includes(h));
  if (w) {
    const pl = w.weeklyPointLeaders;
    for (const [key, lab] of [["poA", "Po.A"], ["poB", "Po.B"], ["poC", "Po.C"]]) {
      const c = pl[key];
      if (c) ck(`[${t.l}] ${w.seasonWeekName} ${lab} '${c.name} 님 (${c.points}개)' 렌더`, b.includes(`${c.name} 님 (${c.points}개)`));
    }
    console.log(`     (${w.seasonWeekName}) A=${pl.poA && pl.poA.name} B=${pl.poB && pl.poB.name} C=${pl.poC && pl.poC.name}`);
  }
  await page.screenshot({ path: `claudedocs/members-info-pointleaders-${t.o}.png` });
}
await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
