// 캡 제거 후 검증: 넓은 뷰포트에서 각 테이블 페이지가 full width 사용 + body 오버플로 0.
//   보고: docOverflow, 표외 bleeders, 콘텐츠 래퍼 실폭 vs main 가용폭(캡 잔존 여부),
//   표 폭 vs 스크롤러 가용폭(가로 스크롤 여부). 스크린샷 저장.
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
const VW = Number(process.env.VW ?? 1920);

const PAGES = [
  ["register", "/admin/processes/register?org=encre"],
  ["check", "/admin/processes/check?org=encre"],
  ["irregular", "/admin/processes/check/irregular?org=encre"],
  ["p-info", "/admin/line-opening/practical-info?org=encre"],
  ["p-comp", "/admin/line-opening/practical-competency?org=encre"],
  ["p-exp", "/admin/line-opening/practical-experience?org=encre"],
  ["appusers", "/admin/users/app-users?org=encre"],
];

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: VW, height: 1000 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
let fail = 0;
try {
  for (const [slug, url] of PAGES) {
    try { await page.goto(`${BASE}${url}`, { waitUntil: "networkidle", timeout: 30000 }); }
    catch { await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded", timeout: 30000 }); }
    await page.waitForTimeout(1400);
    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `qa-fw-${VW}-${slug}.png`), fullPage: false });
    const info = await page.evaluate(() => {
      const vw = window.innerWidth;
      const docOverflow = document.documentElement.scrollWidth - vw;
      const main = document.querySelector("main");
      const mainW = main ? Math.round(main.clientWidth) : null; // p-6 제외 전 content box
      // 콘텐츠 래퍼 = main 의 첫 자식
      const wrapper = main?.firstElementChild;
      const wrapW = wrapper ? Math.round(wrapper.getBoundingClientRect().width) : null;
      const bleeders = Array.from(document.querySelectorAll("main *")).filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        if (el.closest('[data-slot="table-container"]')) return false;
        return r.right > vw + 2;
      }).length;
      // 표 스크롤 여부(가장 큰 표 기준)
      let tableScroll = false, tables = 0;
      document.querySelectorAll('[data-slot="table-container"] > div').forEach((sc) => {
        tables++;
        if (sc.scrollWidth > sc.clientWidth + 2) tableScroll = true;
      });
      return { docOverflow, mainW, wrapW, bleeders, tables, tableScroll };
    });
    const ok = info.docOverflow <= 2 && info.bleeders === 0;
    if (!ok) fail++;
    // 래퍼가 main 가용폭을 (거의) 다 쓰는지 = 캡 잔존 여부
    const usesFull = info.wrapW != null && info.mainW != null && info.wrapW >= info.mainW - 40;
    console.log(`  ${ok ? "✓" : "✗"} ${slug.padEnd(9)} main=${info.mainW} wrap=${info.wrapW} fullWidth=${usesFull ? "예" : "아니오"} · 표 ${info.tables}개 스크롤=${info.tableScroll ? "예" : "아니오"} · docOverflow=${info.docOverflow} bleeders=${info.bleeders}`);
  }
  console.log(`\n=== VW=${VW}: ${fail === 0 ? "OK" : "FAIL"} (${fail} bad) ===`);
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
