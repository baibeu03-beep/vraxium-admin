// 브라우저 검증 — 라인 개설 결과 알림 하단 toast 통일 + 문구 단순화.
//   안전(비변경) 액션인 [초기화](DB 통신 없음, 프론트 로컬 복원)만 실행해 확인:
//     ① 실행 후 하단 toast(role=status)에 "초기화가 완료되었습니다." 표시
//     ② 페이지 본문에 상단 인라인 결과 박스(초록/빨강 border div) 미삽입
//   experience 허브 팀 총괄 보드의 [초기화] 사용. read-safe(개설/검수/취소 버튼은 클릭하지 않음).
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
const ORGS = ["encre", "oranke", "phalanx"];

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.setDefaultNavigationTimeout(180000); // dev 콜드 컴파일(대량 변경 후) 흡수.

// 옛 인라인 결과 박스 탐지 — 성공/오류 배너의 특징 클래스(성공 초록/오류 빨강 border+bg) div.
const INLINE_BANNER_SEL = 'div.rounded-md.border-green-300, div.rounded-md.border-red-300, div[class*="border-green-300"][class*="bg-green-50"], div[class*="border-red-300"][class*="bg-red-50"]';

async function verify(org) {
  const url = `${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll('[role="tablist"] button[role="tab"]').length > 0, { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // 파트 드롭다운 → 팀 총괄 선택(React onChange) → 보드/초기화 버튼 대기.
  const idx = await page.evaluate(() => {
    const sels = Array.from(document.querySelectorAll("select"));
    for (let i = 0; i < sels.length; i++) if (Array.from(sels[i].options).some((o) => o.textContent.trim() === "팀 총괄")) return i;
    return -1;
  });
  if (idx < 0) { ck(`[${org}] 팀 총괄 옵션`, false, "미로드"); return; }
  await page.locator("select").nth(idx).selectOption({ label: "팀 총괄" }).catch(() => {});
  await page.waitForFunction(() => Array.from(document.querySelectorAll("button")).some((b) => /^초기화$/.test((b.textContent || "").trim())), { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(600);

  // 초기화 버튼(활성) 클릭.
  const resetBtn = page.locator('button:has-text("초기화")').first();
  const enabled = await resetBtn.isEnabled().catch(() => false);
  ck(`[${org}] [초기화] 버튼 활성`, enabled);
  if (!enabled) return;
  await resetBtn.click();
  await page.waitForTimeout(900);

  // ① 하단 toast(role=status)에 표준 문구.
  const toastText = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[role="status"], [role="alert"]'));
    return nodes.map((n) => (n.textContent || "").trim()).join(" | ");
  });
  ck(`[${org}] 하단 toast "초기화가 완료되었습니다." 표시`, /초기화가 완료되었습니다\./.test(toastText), toastText || "(toast 없음)");

  // ② 본문 인라인 결과 박스 미삽입.
  const inlineCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, INLINE_BANNER_SEL);
  ck(`[${org}] 상단 인라인 결과 박스 없음`, inlineCount === 0, `count=${inlineCount}`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", `lineopening-toast-${org}.png`), fullPage: false });
}

try {
  for (const org of ORGS) await verify(org);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "lineopening-toast-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
