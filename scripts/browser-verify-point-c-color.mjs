// 브라우저 실측: 어드민 포인트 색상/부호 정책 (2026-07-13).
//   Point A/B = 연두(green, text-point-good) · Point C = 빨강(red, text-point-danger) · C 는 항상 양수(마이너스 없음).
//   대상: /admin/processes/register (Po.A/B/C 마스터 표) + /admin/members (poA/poB/poC 누적).
//   사전조건: admin dev :3000.  node scripts/browser-verify-point-c-color.mjs
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// computed color 파싱 — 브라우저는 oklch 토큰을 rgb() 또는 lab() 로 반환한다. 둘 다 지원.
const parseColor = (s) => {
  const rgb = String(s).match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const [r, g, b] = rgb[1].split(/[,\s/]+/).map((x) => parseFloat(x));
    return { kind: "rgb", r, g, b };
  }
  const lab = String(s).match(/lab\(([^)]+)\)/);
  if (lab) {
    const [L, a, b] = lab[1].split(/[\s/]+/).map((x) => parseFloat(x));
    return { kind: "lab", L, a, b };
  }
  return null;
};
// red: lab a≫0 (적) / rgb R 우세.  green(연두): lab a≪0 (녹) / rgb G 우세.
const isRed = (c) =>
  c && (c.kind === "lab" ? c.a > 40 : c.r > 120 && c.r > c.g + 40 && c.r > c.b + 40);
const isGreen = (c) =>
  c && (c.kind === "lab" ? c.a < -20 : c.g > 90 && c.g > c.r + 20 && c.g > c.b + 20);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1680, height: 1400 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 클래스 기반으로 A/B(good)·C(danger) 요소의 computed color + 텍스트를 수집.
const sampleColors = () =>
  page.evaluate(() => {
    const collect = (cls) =>
      [...document.querySelectorAll(`.${cls}`)]
        .filter((el) => (el.textContent ?? "").trim() !== "")
        .slice(0, 40)
        .map((el) => ({ color: getComputedStyle(el).color, text: el.textContent.trim() }));
    return { good: collect("text-point-good"), danger: collect("text-point-danger") };
  });

async function poll(pred, ms = 45000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await sampleColors();
    if (pred(last)) return last;
    await page.waitForTimeout(1500);
  }
  return last;
}

async function checkPage(path, label) {
  console.log(`\n[${label}] ${path}`);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  const r = await poll((s) => s.good.length > 0 && s.danger.length > 0);
  ck(`Point A/B(good) 요소 존재`, r.good.length > 0, `${r.good.length}개`);
  ck(`Point C(danger) 요소 존재`, r.danger.length > 0, `${r.danger.length}개`);
  const goodColors = r.good.map((x) => parseColor(x.color));
  const dangerColors = r.danger.map((x) => parseColor(x.color));
  const allGoodGreen = goodColors.length > 0 && goodColors.every(isGreen);
  const allDangerRed = dangerColors.length > 0 && dangerColors.every(isRed);
  ck(`Point A/B 숫자 = 연두(green)`, allGoodGreen, `예: ${r.good[0]?.text}=${r.good[0]?.color}`);
  ck(`Point C 숫자 = 빨강(red)`, allDangerRed, `예: ${r.danger[0]?.text}=${r.danger[0]?.color}`);
  const cHasMinus = r.danger.some((x) => /^-/.test(x.text));
  ck(`Point C 에 마이너스 부호 없음`, !cHasMinus, cHasMinus ? `위반: ${r.danger.find((x) => /^-/.test(x.text))?.text}` : `${r.danger.length}개 모두 양수`);
  const shot = `claudedocs/point-c-color-${label}.png`;
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`  📸 ${shot}`);
  return r;
}

await checkPage("/admin/processes/register?org=oranke", "process-master");
await checkPage("/admin/members?org=oranke", "members");

console.log(`\n결과: ${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
await browser.close();
process.exit(fail ? 1 : 0);
