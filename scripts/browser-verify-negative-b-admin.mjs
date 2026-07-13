// 브라우저 실측: 어드민 members 표 Po.B 가 최종B(음수 가능)로 표시되는지.
//   Po.B 헤더로 오름차순 정렬 → 최상단 = 최종B 최소(음수) 사용자. node scripts/browser-verify-negative-b-admin.mjs
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
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const parse = (s) => { const m = String(s).match(/lab\(([^)]+)\)/); if (m) { const [, a] = m[1].split(/[\s/]+/).map(Number); return { lab: true, a }; } const r = String(s).match(/rgba?\(([^)]+)\)/); if (r) { const [x, g, b] = r[1].split(/[,\s/]+/).map(Number); return { r: x, g, b }; } return null; };
const isGreen = (c) => c && (c.lab ? c.a < -20 : c.g > 90 && c.g > c.r + 20);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();
await page.goto(`${BASE}/admin/members?org=encre`, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(3500);

// text-point-good 셀(=Po.A/Po.B) 수집. Po.A 는 항상 ≥0 이므로 음수 값은 Po.B(최종B)뿐.
const readGood = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".text-point-good")]
      .filter((el) => (el.textContent ?? "").trim() !== "")
      .map((el) => ({ text: el.textContent.trim(), color: getComputedStyle(el).color })),
  );
// Po.B 헤더 클릭(정렬). 음수 값이 페이지에 나타날 때까지 최대 2회 토글.
async function clickPoB() {
  try { await page.getByText(/^Po\.\s*B$/).first().click({ timeout: 4000 }); } catch {}
  await page.waitForTimeout(2500);
}

// 표 렌더까지 폴링(dev 재컴파일/통합 로스터 지연 대비)
let good = [];
{ const t0 = Date.now(); while (Date.now() - t0 < 60000) { good = await readGood(); if (good.length > 0) break; await page.waitForTimeout(2000); } }
for (let i = 0; i < 3 && !good.some((x) => /^-\d/.test(x.text)); i++) { await clickPoB(); good = await readGood(); }

const neg = good.filter((x) => /^-\d/.test(x.text));
console.log(`text-point-good 셀 ${good.length}개 · 음수(=Po.B 최종B) ${neg.length}개`);
for (const n of neg.slice(0, 6)) console.log(`  Po.B=${n.text}  color=${n.color}`);
ck("어드민 members Po.B 가 음수로 표시됨(최종B = rawB−C)", neg.length > 0, `음수 Po.B ${neg.length}개 · 예: ${neg[0]?.text}`);
ck("음수 Po.B 도 연두(green) — 부호 아닌 '포인트 종류' 기준", neg.length > 0 && isGreen(parse(neg[0]?.color)), `${neg[0]?.text}=${neg[0]?.color}`);
await page.screenshot({ path: "claudedocs/negative-b-admin-members.png", fullPage: false });
console.log("📸 claudedocs/negative-b-admin-members.png");
console.log(`\n결과: ${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
await browser.close();
process.exit(fail ? 1 : 0);
