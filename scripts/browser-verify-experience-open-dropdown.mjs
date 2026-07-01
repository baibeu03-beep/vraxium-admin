// 브라우저 검증 — 실무 경험 [라인 개설] 팀/파트 드롭다운 (QA 고정, 운영 URL = mode 미부착).
//   /admin/line-opening/practical-experience?org=<org>&tab=open 에서
//   ① 팀 탭이 (T) 테스트 팀으로 노출  ② 파트 드롭다운 옵션 존재  ③ 크루 그리드 렌더(빈칸 아님).
// read-only(개설 신청 버튼 클릭 없음 — 표시 스코프만). 3개 조직 전수.
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

try {
  for (const org of ORGS) {
    await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);

    // ① 팀 탭 — (T) 팀 노출 / 운영 팀 미노출. 파트장 입력 카드 내부의 팀 버튼.
    const teamTabs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .map((b) => (b.textContent || "").trim())
        .filter((t) => /\(T\)/.test(t)),
    );
    ck(`[${org}] 팀 탭에 (T) 테스트 팀 노출`, teamTabs.length >= 1, `tabs=[${teamTabs.join(", ")}]`);

    // ② 파트 드롭다운(<select>) 옵션 — "팀 총괄" 외 실제 파트 존재.
    const partOpts = await page.evaluate(() => {
      const sels = Array.from(document.querySelectorAll("select"));
      for (const s of sels) {
        const opts = Array.from(s.options).map((o) => o.textContent.trim());
        if (opts.includes("팀 총괄")) return opts.filter((o) => o !== "팀 총괄");
      }
      return [];
    });
    ck(`[${org}] 파트 드롭다운 실제 파트 옵션 존재`, partOpts.length >= 1, `parts=[${partOpts.join(", ")}]`);

    // ③ 크루 그리드 — "평가 대상 크루가 없습니다" 문구 부재(= 크루 렌더).
    const emptyMsg = await page.evaluate(() =>
      /평가 대상 크루가 없습니다/.test(document.body.innerText),
    );
    ck(`[${org}] 크루 그리드 렌더(빈칸 아님)`, !emptyMsg);

    await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-open-dropdown-${org}.png`), fullPage: false });
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "exp-open-dropdown-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
