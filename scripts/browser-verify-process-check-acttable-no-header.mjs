// 브라우저 검증 — ProcessCheckActTable CardHeader(제목/설명) 제거.
//   info/experience 모두: "[섹션.1] 액트 목록" 제목 + "신청 시점(필요) 순 …" 설명 사라짐.
//   액트 테이블 헤더(액트명/상태 등)·상태 버튼은 유지. 읽기 전용·net-zero.
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

  for (const [hub, url] of [["info", `${BASE}/admin/processes/check/info?org=oranke`], ["experience", `${BASE}/admin/processes/check/experience?org=oranke`]]) {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);
    const body = (await page.locator("body").textContent()) ?? "";
    ck(`[${hub}] '[섹션.1] 액트 목록' 제목 제거됨`, !/\[섹션\.1\] 액트 목록/.test(body));
    ck(`[${hub}] '신청 시점(필요) 순 …팝업' 설명 제거됨`, !/상태 버튼 클릭 시 체크 신청\/취소 팝업/.test(body));
    // 테이블 자체는 유지(컬럼 헤더 존재).
    ck(`[${hub}] 액트 테이블 유지(컬럼 헤더 '액트명'/'상태')`, /액트명/.test(body) && /크루 반응/.test(body));
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
