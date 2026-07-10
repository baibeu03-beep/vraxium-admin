// 브라우저(인증 세션) 스모크 — 사이드바 상단 조직명 라벨(엥크레/오랑캐/팔랑크스).
//   변경(텍스트 라벨화): 배경/테두리 없음 · 조직 대표 글자색 · 개별/통합(text-sm)보다 작은 text-xs.
//   순서: HOME → 개별/통합 → 조직명. 라벨/색 = lib/organizations SoT.
//   · org 페이지(/admin/crews/{org})에서 개별 + 조직명 라벨, 통합(/admin/members)에서는 조직명 미표시.
//   · 일반 모드 == mode=test 동일.
// 사용법: node scripts/browser-verify-org-badge.mjs
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
const TRANSPARENT = new Set(["rgba(0, 0, 0, 0)", "transparent"]);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// text-* 클래스의 computed color(참조).
async function refTextColor(className) {
  return page.evaluate((cls) => {
    const d = document.createElement("span");
    d.className = cls; d.textContent = "x"; document.body.appendChild(d);
    const v = getComputedStyle(d).color; d.remove(); return v;
  }, className);
}
async function badgeStyle(text) {
  const el = page.locator(`span:has-text("${text}")`).filter({ hasText: new RegExp(`^${text}$`) }).first();
  await el.waitFor({ state: "visible", timeout: 15000 });
  return el.evaluate((n) => {
    const s = getComputedStyle(n);
    return { bg: s.backgroundColor, color: s.color, border: s.borderStyle, borderW: s.borderTopWidth, fs: parseFloat(s.fontSize), radius: s.borderTopLeftRadius };
  });
}
async function badgeOrder() {
  return page.evaluate(() => {
    const home = Array.from(document.querySelectorAll("a")).find((a) => a.textContent?.trim() === "HOME");
    if (!home) return null;
    return Array.from(home.parentElement.querySelectorAll("span")).map((s) => s.textContent.trim()).filter(Boolean);
  });
}
async function gotoOrg(path) { await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" }); }

await gotoOrg("/admin/members");
const REF = {
  pink: await refTextColor("text-pink-600"),
  amber: await refTextColor("text-amber-600"),
  emerald: await refTextColor("text-emerald-600"),
};
console.log(`  (ref text: pink-600=${REF.pink} · amber-600=${REF.amber} · emerald-600=${REF.emerald})`);

// 통합 모드 — 조직명 미표시.
check("통합 모드(/admin/members) 순서 = 통합만(조직명 미표시)", JSON.stringify(await badgeOrder()) === JSON.stringify(["통합"]), JSON.stringify(await badgeOrder()));

const ORGS = [
  { slug: "encre", label: "엥크레", ref: "pink" },
  { slug: "oranke", label: "오랑캐", ref: "amber" },
  { slug: "phalanx", label: "팔랑크스", ref: "emerald" },
];

for (const mode of ["operating", "test"]) {
  const q = mode === "test" ? "?mode=test" : "";
  console.log(`\n[${mode === "test" ? "mode=test" : "일반 모드"}]`);
  for (const o of ORGS) {
    await gotoOrg(`/admin/crews/${o.slug}${q}`);
    check(`${o.slug}: 순서 = 개별, ${o.label}`, JSON.stringify(await badgeOrder()) === JSON.stringify(["개별", o.label]));
    const s = await badgeStyle(o.label);
    const badge = await badgeStyle("개별"); // 개별 배지 폰트 크기 기준
    check(`${o.slug}: 배경 없음(투명)`, TRANSPARENT.has(s.bg), s.bg);
    check(`${o.slug}: 테두리 없음`, s.border === "none" || parseFloat(s.borderW) === 0, `${s.border}/${s.borderW}`);
    check(`${o.slug}: 둥근 배지 아님(radius 0)`, parseFloat(s.radius) === 0, s.radius);
    check(`${o.slug}: 글자색 = ${o.ref}-600`, s.color === REF[o.ref], s.color);
    check(`${o.slug}: 폰트 < 개별/통합(${s.fs}px < ${badge.fs}px)`, s.fs < badge.fs, `${s.fs} vs ${badge.fs}`);
    if (o.slug === "encre") await page.screenshot({ path: resolve(adminRoot, `claudedocs/qa-org-label-${o.slug}-${mode}.png`) });
  }
}

// ?org= 파라미터 공유 페이지도 동일 라벨.
await gotoOrg("/admin/lines/register?org=phalanx");
{
  const s = await badgeStyle("팔랑크스");
  check("?org=phalanx 공유페이지: 팔랑크스 라벨 emerald-600 텍스트·배경 없음", s.color === REF.emerald && TRANSPARENT.has(s.bg), `${s.color} / ${s.bg}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (pass=${pass}, fail=${fail})`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
