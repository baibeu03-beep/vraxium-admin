// 브라우저 검증 — 라인 개설 예외 org+hub.
//   ① 설정 페이지(/admin/settings/line-opening-windows): 조직 범위(#low-org)+라인 종류(#low-hub) 드롭다운 렌더.
//   ② encre+experience 예외 등록 → 경험 개설(encre) 주차 select 에 그 주차 옵션 등장(값=weekId).
//   ③ 스코핑: oranke 경험 개설 select 에는 미등장.
//   ④ 삭제 후 즉시 제외.
//   스크린샷: claudedocs/line-opening-windows-org-hub.png. 전제: dev 서버 + 마이그.
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
const EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SVC = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SVC);
async function makeCookies() {
  const a = createClient(URL, SVC), b = createClient(URL, ANON);
  const { data: l } = await a.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await b.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = []; const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 페이지의 모든 select 옵션 값 집합.
async function selectValues(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("select")).flatMap((s) =>
      Array.from(s.options).map((o) => o.value)),
  );
}
async function waitExpSelect(page) {
  await page.waitForFunction(() => Array.from(document.querySelectorAll("select")).some((s) => Array.from(s.options).some((o) => /주차|W\d/.test(o.textContent || ""))), undefined, { timeout: 90000 });
}

let weekId = null, winId = null;
const cks = await makeCookies();
const cookieHdr = cks.map((c) => `${c.name}=${c.value}`).join("; ");
async function cleanup() { if (weekId) await sb.from("line_opening_windows").delete().eq("week_id", weekId); }

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await context.addCookies(cks);
const page = await context.newPage();
try {
  const { data: latest } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  weekId = latest.id;
  await cleanup();

  // ── ① 설정 페이지 UX ──
  await page.goto(`${BASE}/admin/settings/line-opening-windows`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  ck("[설정] 제목 '라인 개설 기간'", ((await page.locator("body").textContent()) ?? "").includes("라인 개설 기간"));
  ck("[설정] 조직 범위 드롭다운(#low-org)", (await page.locator("#low-org").count()) > 0);
  ck("[설정] 라인 종류 드롭다운(#low-hub)", (await page.locator("#low-hub").count()) > 0);
  const orgOpts = (await page.locator("#low-org option").allTextContents()).map((t) => t.trim());
  ck("[설정] 조직 옵션(전체/Encre/Oranke/Phalanx)", ["전체 조직", "Encre", "Oranke", "Phalanx"].every((o) => orgOpts.includes(o)), JSON.stringify(orgOpts));
  const hubOpts = (await page.locator("#low-hub option").allTextContents()).map((t) => t.trim());
  ck("[설정] 라인 종류 옵션(전체/실무 정보/실무 경험/실무 역량)", ["전체 라인 종류", "실무 정보", "실무 경험", "실무 역량"].every((o) => hubOpts.includes(o)), JSON.stringify(hubOpts));
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "line-opening-windows-org-hub.png"), fullPage: true });

  // ── 예외 등록(API·encre+experience) → 설정 목록 반영 ──
  const post = await (await fetch(`${BASE}/api/admin/line-opening-windows`, { method: "POST", headers: { cookie: cookieHdr, "content-type": "application/json" }, body: JSON.stringify({ week_id: weekId, organization_slug: "encre", hub: "experience" }) })).json();
  winId = post?.data?.windows?.[0]?.id;
  ck("[등록] API POST 성공", !!winId);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const listBody = (await page.locator("body").textContent()) ?? "";
  ck("[설정·목록] Encre + 실무 경험 예외 표시", listBody.includes("Encre") && listBody.includes("실무 경험") && listBody.includes("활성"));

  // ── ② 경험 개설(encre) 주차 select 에 예외 주차 등장 ──
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre&tab=open`, { waitUntil: "domcontentloaded" });
  await waitExpSelect(page);
  const encreVals = await selectValues(page);
  ck("[경험·encre] 개설 주차 select 에 예외 주차 옵션 등장(값=weekId)", encreVals.includes(weekId), `옵션 ${encreVals.length}개`);

  // ── ③ 스코핑: 경험 개설(oranke) 에는 미등장 ──
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });
  await waitExpSelect(page);
  const orankeVals = await selectValues(page);
  ck("[경험·oranke] 예외 주차 미등장(org 스코핑)", !orankeVals.includes(weekId));

  // ── ④ 삭제 후 즉시 제외 ──
  await fetch(`${BASE}/api/admin/line-opening-windows/${winId}`, { method: "DELETE", headers: { cookie: cookieHdr } });
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=encre&tab=open`, { waitUntil: "domcontentloaded" });
  await waitExpSelect(page);
  const afterVals = await selectValues(page);
  ck("[삭제] 삭제 후 encre 경험 select 에서 제외", !afterVals.includes(weekId));
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); await browser.close(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
