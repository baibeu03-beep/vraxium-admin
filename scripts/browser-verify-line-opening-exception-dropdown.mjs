// 브라우저 검증 — 허용(scope=all 예외) 주차가 경험/역량 라인 개설 화면 주차 드롭다운에 실제 표시·선택 가능한지.
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
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SVC = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SVC);
async function makeCookies() {
  const a = createClient(URL, SVC), b = createClient(URL, ANON);
  const { data: l } = await a.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await b.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  const cap = []; const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await context.addCookies(await makeCookies());
const page = await context.newPage();
try {
  // ── 역량 대시보드 ──
  await page.goto(`${BASE}/admin/line-opening/practical-competency?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });
  // weekOptions 로드 완료까지 대기 = "개설 주차" 버튼 텍스트가 "계산할 수 없습니다" 가 아닐 때까지.
  await page.waitForFunction(() => {
    const b = document.querySelector('button[aria-label="개설 주차"]');
    return b && !/계산할 수 없습니다/.test(b.textContent || "");
  }, undefined, { timeout: 90000 });
  await page.getByRole("button", { name: "개설 주차" }).click();
  await page.waitForTimeout(600);
  const comp = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const exc = btns.find((b) => /허용 주차/.test(b.textContent || ""));
    return { hasExc: !!exc, text: exc?.textContent?.replace(/\s+/g, " ").trim() ?? "", disabled: exc ? exc.disabled : null };
  });
  ck("[역량] 드롭다운에 '허용 주차' 옵션 표시", comp.hasExc, comp.text);
  ck("[역량] 허용 주차 옵션 선택 가능(disabled=false)", comp.disabled === false);
  if (comp.hasExc) {
    await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((x) => /허용 주차/.test(x.textContent || ""))?.click());
    await page.waitForTimeout(500);
    const label = await page.evaluate(() => document.querySelector('button[aria-label="개설 주차"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "");
    ck("[역량] 허용 주차 선택 → 상단 표기 반영(10주차)", /10주차/.test(label), label);
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "exc-dropdown-competency.png"), fullPage: true });

  // ── 경험 파트장 입력 ──
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=oranke&tab=open`, { waitUntil: "domcontentloaded" });
  // 개설 주차 select 렌더까지 대기(부트 로딩 완료).
  await page.waitForFunction(() => {
    const sels = Array.from(document.querySelectorAll("select"));
    return sels.some((s) => Array.from(s.options).some((o) => /W\d/.test(o.textContent || "")));
  }, undefined, { timeout: 90000 });
  const exp = await page.evaluate(() => {
    for (const sel of Array.from(document.querySelectorAll("select"))) {
      const opts = Array.from(sel.options).map((o) => ({ text: o.textContent?.replace(/\s+/g, " ").trim() ?? "", disabled: o.disabled }));
      if (opts.some((o) => /W\d/.test(o.text))) {
        const w10 = opts.find((o) => /W10\b/.test(o.text) || /봄 시즌 W10/.test(o.text));
        return { found: !!w10, w10, sample: opts.map((o) => o.text) };
      }
    }
    return { found: false, w10: null, sample: [] };
  });
  ck("[경험] 개설 주차 select 에 봄 W10(허용 주차) 옵션 존재", exp.found, JSON.stringify(exp.w10));
  ck("[경험] W10 옵션 선택 가능(disabled=false)", exp.w10 ? exp.w10.disabled === false : false);
  console.log("   경험 주차 옵션:", JSON.stringify(exp.sample));
  // 실제 선택
  if (exp.found) {
    const w10Text = exp.w10.text;
    await page.evaluate((t) => {
      for (const sel of document.querySelectorAll("select")) {
        const opt = Array.from(sel.options).find((o) => (o.textContent || "").replace(/\s+/g, " ").trim() === t);
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); return; }
      }
    }, w10Text);
    await page.waitForTimeout(500);
    const selected = await page.evaluate((t) => {
      for (const sel of document.querySelectorAll("select")) {
        const cur = Array.from(sel.options).find((o) => o.selected);
        if (cur && (cur.textContent || "").replace(/\s+/g, " ").trim() === t) return true;
      }
      return false;
    }, w10Text);
    ck("[경험] W10 선택 반영됨", selected);
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "exc-dropdown-experience.png"), fullPage: true });
} catch (e) {
  console.error("browser error:", e?.message ?? e); fail++;
} finally {
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
