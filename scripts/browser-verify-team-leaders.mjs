// 브라우저 검증 — /admin/team-parts/info 팀 box 팀장 클래스/품계 표시 + 무매칭 "-".
//   매칭(이유진/노서정): 이름·클래스·품계 표시. 무매칭(김지희): 이름만, 클래스/품계 "-".
//   이름없음(팔랑크스 브랜딩/서비스): 이름·클래스·품계 모두 "-".
//   READ-ONLY(쓰기 없음). 전제: dev :3000 + leader_name 마이그레이션 + 백필 적용.
//   스크린샷: claudedocs/team-leaders-box.png
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
const attrText = async (page, attr, val) =>
  (await page.locator(`[${attr}="${val}"]`).first().textContent().catch(() => ""))?.trim() ?? "";

const browser = await chromium.launch();
try {
  const cks = await cookies();
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 1400 } });
  await ctx.addCookies(cks);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/admin/team-parts/info`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // 기본 반기 = 2026-H1(현재). 기본 탭 = encre.
  ck("현재 반기(2026 상반기) 선택", (await page.locator("#team-parts-half-select").inputValue()) === "2026-H1");

  // ── encre: 매칭 팀장 이유진(A&R) — 이름+클래스+품계 ──
  await page.locator('[data-org-tab="encre"]').click();
  await page.waitForTimeout(600);
  {
    const name = await attrText(page, "data-team-leader-name", "A&R");
    const cls = await attrText(page, "data-team-leader-class", "A&R");
    const grade = await attrText(page, "data-team-leader-grade", "A&R");
    ck("[encre/A&R] 이름=이유진", name === "이유진", name);
    ck("[encre/A&R] 클래스 표시(≠'-')", cls === "운영진(팀장)", cls);
    ck("[encre/A&R] 품계 표시(≠'-')", grade === "정4품", grade);
  }
  // ── encre: 무매칭 팀장 김지희(갤러리) — 이름만, 클래스/품계 "-" ──
  {
    const name = await attrText(page, "data-team-leader-name", "갤러리");
    const cls = await attrText(page, "data-team-leader-class", "갤러리");
    const grade = await attrText(page, "data-team-leader-grade", "갤러리");
    ck("[encre/갤러리] 이름=김지희(무매칭이어도 이름 표시)", name === "김지희", name);
    ck('[encre/갤러리] 클래스="-"(무매칭)', cls === "-", cls);
    ck('[encre/갤러리] 품계="-"(무매칭)', grade === "-", grade);
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "team-leaders-box.png"), fullPage: false }).catch(() => {});

  // ── phalanx: 이름없음(브랜딩/서비스) — 전부 "-" / 매칭 IT(이유나) ──
  await page.locator('[data-org-tab="phalanx"]').click();
  await page.waitForTimeout(600);
  for (const team of ["브랜딩", "서비스"]) {
    const name = await attrText(page, "data-team-leader-name", team);
    const cls = await attrText(page, "data-team-leader-class", team);
    const grade = await attrText(page, "data-team-leader-grade", team);
    ck(`[phalanx/${team}] 이름="-"(명단에 이름 없음)`, name === "-", name);
    ck(`[phalanx/${team}] 클래스="-"`, cls === "-", cls);
    ck(`[phalanx/${team}] 품계="-"`, grade === "-", grade);
  }
  {
    const name = await attrText(page, "data-team-leader-name", "IT");
    const cls = await attrText(page, "data-team-leader-class", "IT");
    const boxText = (await page.locator('[data-team-box="IT"]').first().textContent().catch(() => "")) ?? "";
    ck("[phalanx/IT] 이름=이유나(212 이관·정정)", name === "이유나", name);
    ck("[phalanx/IT] 학교=성균관대 표시", boxText.includes("성균관대"), boxText.replace(/\s+/g, " ").slice(0, 120));
    ck("[phalanx/IT] 전공=컴퓨터교육과 표시", boxText.includes("컴퓨터교육과"), boxText.replace(/\s+/g, " ").slice(0, 120));
    ck("[phalanx/IT] 클래스=정규(role=null)", cls === "정규", cls);
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "team-leaders-phalanx.png"), fullPage: false }).catch(() => {});

  // ── 과거 반기(2025-H1)도 백필 반영 확인(읽기) ──
  await page.locator('[data-org-tab="oranke"]').click();
  await page.locator("#team-parts-half-select").selectOption("2025-H2");
  await page.waitForTimeout(900);
  {
    // oranke 2025-H2 콘텐츠 = 한아름(무매칭) → 이름만.
    const name = await attrText(page, "data-team-leader-name", "콘텐츠");
    ck("[oranke/2025-H2/콘텐츠] 무매칭 팀장 이름 표시", name === "한아름", name);
  }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await browser.close(); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
