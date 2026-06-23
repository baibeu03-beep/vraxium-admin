// 브라우저 검증 — /admin/processes/check/irregular 주차 선택 영역 UI.
//   1) 드롭다운/날짜 범위/상태 배지 동일 Y축(세로 중앙) 정렬 ·
//   2) 선택값 = "26년 봄 시즌 17주차 (현재)" 형태 ·
//   3) 모든 옵션이 연도+시즌+주차 형식 · 4) 날짜 범위 · 5) 상태 배지.
//   스크린샷: claudedocs/irregular-week-ui.png. 전제: dev 서버 + 마이그레이션 적용.
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
const ORG = "oranke";
const sb = createClient(URL, SERVICE);

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch();
try {
  const cks = await cookies();
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addCookies(cks);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/processes/check/irregular?org=${ORG}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const sel = page.locator('#irregular-week-select');
  await sel.waitFor({ state: "visible", timeout: 8000 });

  // (2/3) 옵션 텍스트 — 모두 연도+시즌+주차 형식, 선택값은 (현재) 포함.
  const opts = await page.locator('#irregular-week-select option').allTextContents();
  const FMT = /^\d{2}년 .+\s*시즌 \d+주차( \(현재\))?$/;
  const allFmt = opts.length > 0 && opts.every((t) => FMT.test(t.trim()));
  ck("[옵션] 모든 옵션이 '연도+시즌+주차' 형식", allFmt, JSON.stringify(opts.slice(0, 3)) + ` …(${opts.length})`);
  const curOpt = opts.find((t) => t.includes("(현재)")) ?? "";
  ck("[선택값] 현재 옵션 'YY년 시즌 N주차 (현재)' 형태", /^\d{2}년 .+시즌 \d+주차 \(현재\)$/.test(curOpt.trim()), curOpt.trim());
  // 선택된 값이 현재 옵션인지.
  const selectedText = await page.$eval('#irregular-week-select', (el) => el.options[el.selectedIndex]?.textContent?.trim() ?? "");
  ck("[선택값] 드롭다운 현재 선택 = 현재 주차", selectedText.includes("(현재)"), selectedText);

  // (4) 날짜 범위 · (5) 상태 배지.
  const dateSpan = page.locator('span', { hasText: /^\(\d{4}-\d{2}-\d{2} ~ \d{4}-\d{2}-\d{2}\)$/ }).first();
  ck("[날짜] (YYYY-MM-DD ~ YYYY-MM-DD) 표시", await dateSpan.count() > 0, (await dateSpan.textContent().catch(() => "")) ?? "");
  const badge = page.locator('span', { hasText: /^공식 (활동|휴식) 주차$/ }).first();
  ck("[상태] 공식 활동/휴식 주차 배지 표시", await badge.count() > 0, (await badge.textContent().catch(() => "")) ?? "");

  // (1) 세로 중앙 정렬 — select / 날짜 span / 상태 배지의 center Y 가 ±2px 이내.
  const centerY = async (loc) => { const b = await loc.boundingBox(); return b ? b.y + b.height / 2 : null; };
  const cy = [await centerY(sel), await centerY(dateSpan), await centerY(badge)].filter((x) => x != null);
  const spread = cy.length >= 2 ? Math.max(...cy) - Math.min(...cy) : 999;
  ck("[정렬] 드롭다운/날짜/상태 배지 동일 Y축(center ±2px)", spread <= 2, `centers=${cy.map((n) => n.toFixed(1)).join(", ")} spread=${spread.toFixed(2)}px`);

  // 스크린샷 — 주차 선택 행(드롭다운의 부모 flex div).
  const row = sel.locator('xpath=..');
  await row.screenshot({ path: resolve(adminRoot, "claudedocs", "irregular-week-ui.png") });
  console.log("  · screenshot → claudedocs/irregular-week-ui.png");
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
