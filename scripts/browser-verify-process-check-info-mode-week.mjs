// 브라우저 검증 — /admin/processes/check/info 모드별 주차 표시.
//   operating → "16주차"(현재 주차·휴식) · test → "13주차"(13주차 예외). 읽기 전용·net-zero(시드 없음).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");

async function cookies() {
  const admin = createClient(URL, SERVICE), browser = createClient(URL, ANON);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await ctx.addCookies(await cookies());
  const page = await ctx.newPage();

  // operating — 주차명 필드 "16주차".
  await page.goto(`${BASE}/admin/processes/check/info?org=oranke`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const opLabel = (await page.getByLabel("주차명").textContent())?.trim() ?? "";
  ck("[운영] 주차명 = 16주차(현재 주차)", /16주차/.test(opLabel), opLabel);
  ck("[운영] 13주차 아님", !/13주차/.test(opLabel), opLabel);

  // test — 주차명 필드 "13주차".
  await page.goto(`${BASE}/admin/processes/check/info?org=oranke&mode=test`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const teLabel = (await page.getByLabel("주차명").textContent())?.trim() ?? "";
  ck("[테스트] 주차명 = 13주차(13주차 예외)", /13주차/.test(teLabel), teLabel);
  ck("[테스트] 16주차 아님", !/16주차/.test(teLabel), teLabel);

  // 상태창 본문에도 동일 주차 반영.
  const teBody = (await page.locator("body").textContent()) ?? "";
  ck("[테스트] 상태창 본문 13주차 반영", /13주차/.test(teBody));
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
