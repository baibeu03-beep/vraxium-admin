// 브라우저(인증 세션) 스모크 — 사이드바 "통합" 배지 배경색 빨간색(bg-red-600) 확인.
//   1) /admin/members (통합 컨텍스트) → "통합" 배지 = rgb(220,38,38) red-600, 글자 흰색.
//   2) /admin/members?mode=test → 동일(빨간색).
//   3) /admin/crews/encre (조직 컨텍스트) → "개별" 배지 = rgb(37,99,235) blue-600 유지(회귀 없음).
// 사용법: node scripts/browser-verify-unified-badge-red.mjs
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
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// Tailwind v4 는 색을 oklch/lab 로 정의(직렬화도 lab()) — 하드코딩 hex 와 미세 차이가 난다.
//   따라서 실제 Tailwind 클래스(bg-red-600 / bg-blue-600)를 가진 참조 요소의 computed 배경색과
//   raw 문자열을 직접 대조한다(동일 클래스 → 동일 직렬화).
async function refClassColor(className) {
  return page.evaluate((cls) => {
    const d = document.createElement("div");
    d.className = cls;
    document.body.appendChild(d);
    const v = getComputedStyle(d).backgroundColor;
    d.remove();
    return v;
  }, className);
}
async function whiteColor() {
  return page.evaluate(() => {
    const d = document.createElement("div");
    d.style.color = "#ffffff";
    document.body.appendChild(d);
    const v = getComputedStyle(d).color;
    d.remove();
    return v;
  });
}

// 배지(span) 를 텍스트로 찾아 배경색/글자색(raw computed 문자열) 읽기.
async function badgeStyle(text) {
  const el = page.locator(`span:has-text("${text}")`).filter({ hasText: new RegExp(`^${text}$`) }).first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  return el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { bg: s.backgroundColor, color: s.color };
  });
}

// 1) 통합 컨텍스트(일반 모드).
await page.goto(`${BASE}/admin/members`, { waitUntil: "networkidle" });
const RED = await refClassColor("bg-red-600");
const BLUE = await refClassColor("bg-blue-600");
const WHITE = await whiteColor();
console.log(`  (ref: red-600=${RED} · blue-600=${BLUE} · white=${WHITE})`);
let s = await badgeStyle("통합");
check("일반 모드 · '통합' 배지 배경 = Tailwind red-600", s.bg === RED, s.bg);
check("일반 모드 · '통합' 배지 글자 흰색", s.color === WHITE, s.color);
await page.screenshot({ path: resolve(adminRoot, "claudedocs/qa-unified-badge-red-normal.png") });

// 2) 통합 컨텍스트(test 모드).
await page.goto(`${BASE}/admin/members?mode=test`, { waitUntil: "networkidle" });
s = await badgeStyle("통합");
check("test 모드 · '통합' 배지 배경 = Tailwind red-600", s.bg === RED, s.bg);
check("test 모드 · '통합' 배지 글자 흰색", s.color === WHITE, s.color);
await page.screenshot({ path: resolve(adminRoot, "claudedocs/qa-unified-badge-red-test.png") });

// 3) 조직 컨텍스트 → '개별' 배지 파란색 유지(회귀 없음).
await page.goto(`${BASE}/admin/crews/encre`, { waitUntil: "networkidle" });
try {
  s = await badgeStyle("개별");
  check("조직 모드 · '개별' 배지 배경 = Tailwind blue-600 유지(회귀 없음)", s.bg === BLUE, s.bg);
} catch (e) {
  check("조직 모드 · '개별' 배지 확인", false, String(e).slice(0, 80));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (pass=${pass}, fail=${fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
