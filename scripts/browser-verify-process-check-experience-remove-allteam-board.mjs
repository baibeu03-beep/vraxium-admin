// 브라우저 검증 — experience 체크 화면에서 "상태창 2 · …(전체 팀)" 카드 제거.
//   experience → (전체 팀) 카드 없음 · 선택 팀 상태창2(선택 팀) 유지 · 액트 테이블 유지.
//   info(비팀 허브) → "상태창 2 · 이번 주 체크 진행 현황" 카드 그대로(회귀 없음). 읽기 전용·net-zero.
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

  // experience — (전체 팀) 카드 제거 확인.
  await page.goto(`${BASE}/admin/processes/check/experience?org=oranke`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const expBody = (await page.locator("body").textContent()) ?? "";
  ck("[experience] '(전체 팀)' 카드 제거됨", !/\(전체 팀\)/.test(expBody));
  ck("[experience] 선택 팀 상태창2(상태창 2 ·) 유지", /상태창 2 ·/.test(expBody), "선택 팀 상태창2");
  ck("[experience] 액트 목록 테이블 유지(헤더 '소속 라인 급')", /소속 라인 급/.test(expBody));
  ck("[experience] 로그창/상태창 헤더 유지", /로그창/.test(expBody) && /상태창/.test(expBody));

  // info — (비팀) 상태창2 카드 그대로(회귀 없음).
  await page.goto(`${BASE}/admin/processes/check/info?org=oranke`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const infoBody = (await page.locator("body").textContent()) ?? "";
  ck("[info] '상태창 2 · 이번 주 체크 진행 현황' 카드 유지", /상태창 2 · 이번 주 체크 진행 현황/.test(infoBody));
  ck("[info] info 엔 '전체 팀' 문구 없음(원래 없음)", !/전체 팀/.test(infoBody));
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
