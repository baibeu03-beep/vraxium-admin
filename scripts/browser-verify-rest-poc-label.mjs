// 검증(브라우저) — 긴급 휴식 모달의 Po.C 표시명 스코프 분기.
//   [개별](?org=slug): 조직별 명칭(encre=번개 / oranke=어흥 / phalanx=화살) × 2
//   [통합](?org 없음, 특정 조직 탭 선택): 중립 "Po.C × 2" 유지
//   일반 모드 / mode=test 모두 동일해야 한다.
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-rest-poc-label.mjs
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
const EMAIL = "vanuatu.golden@gmail.com"; // owner (전체 허용)

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 모달 헤더의 "즉시 XXX × 2 가 부여됩니다" 에서 XXX(라벨) 추출.
async function openModalAndReadLabel() {
  const btn = page.locator('button', { hasText: "긴급 휴식 신청" }).first();
  await btn.waitFor({ state: "visible", timeout: 30000 });
  // 하이드레이션 전 클릭이 유실될 수 있어, 모달 h2 가 뜰 때까지 클릭을 재시도.
  const h2 = page.locator('h2:has-text("긴급 휴식 신청")');
  for (let i = 0; i < 5; i++) {
    await btn.click({ force: true }).catch(() => {});
    try { await h2.waitFor({ state: "visible", timeout: 4000 }); break; } catch { await page.waitForTimeout(500); }
  }
  await h2.waitFor({ state: "visible", timeout: 5000 });
  const p = page.locator('p', { hasText: "부여됩니다" }).first();
  await p.waitFor({ state: "visible", timeout: 15000 });
  const txt = (await p.innerText()).replace(/\s+/g, " ").trim();
  const m = txt.match(/즉시\s*(.+?)\s*×\s*2/);
  // 모달 닫기(닫기 버튼).
  await page.locator('button', { hasText: "닫기" }).first().click().catch(() => {});
  await page.waitForTimeout(300);
  return { raw: txt, label: m ? m[1].trim() : null };
}

async function individual(org, mode) {
  const url = `${BASE}/admin/rest-management?org=${org}${mode ? "&mode=test" : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  return openModalAndReadLabel();
}

async function integrated(tabLabel, mode) {
  const url = `${BASE}/admin/rest-management${mode ? "?mode=test" : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  // 통합 경로: 특정 조직 탭을 눌러 본문(버튼/모달)을 띄운다.
  await page.locator('button', { hasText: tabLabel }).first().click();
  await page.waitForTimeout(1200);
  return openModalAndReadLabel();
}

const EXPECT_INDIV = { encre: "번개", oranke: "어흥", phalanx: "화살" };

console.log("\n▶ [개별] × 일반 모드");
for (const org of ["encre", "oranke", "phalanx"]) {
  const r = await individual(org, false);
  ck(`${org} → "${EXPECT_INDIV[org]} × 2"`, r.label === EXPECT_INDIV[org], `실제: "${r.label}" (${r.raw})`);
}

console.log("\n▶ [개별] × mode=test");
for (const org of ["encre", "oranke", "phalanx"]) {
  const r = await individual(org, true);
  ck(`${org} → "${EXPECT_INDIV[org]} × 2"`, r.label === EXPECT_INDIV[org], `실제: "${r.label}" (${r.raw})`);
}

console.log("\n▶ [통합] × 일반 모드 (엥크레 탭 선택)");
{
  const r = await integrated("엥크레", false);
  ck(`통합 → "Po.C × 2" 유지`, r.label === "Po.C", `실제: "${r.label}" (${r.raw})`);
}

console.log("\n▶ [통합] × mode=test (엥크레 탭 선택)");
{
  const r = await integrated("엥크레", true);
  ck(`통합 → "Po.C × 2" 유지`, r.label === "Po.C", `실제: "${r.label}" (${r.raw})`);
}

await browser.close();
console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
process.exit(fail === 0 ? 0 : 1);
