// 검증(브라우저) — 팀 목록 스코프 중앙화(filterTeamsByScope) 실제 화면.
//   practical-experience(manage/open/팀별 개설 현황) + process-check(experience) 에서
//   operating=(T) 팀 0건 / mode=test=(T) 팀 노출 을 확인한다.
// read-only(백엔드 write 없음 · snapshot 무관 — 표시 스코프만).
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
const ORG = "encre";

let pass = 0,
  fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name,
  value: i.value,
  domain: "localhost",
  path: "/",
  httpOnly: false,
  secure: false,
  sameSite: "Lax",
}));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();

const goto = async (path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
};
// (T) 테스트 팀 라벨 등장 횟수. 테스트 모드 토글 버튼("테스트 모드 ON/OFF")엔 "(T)" 없음.
const countTeamT = () =>
  page.evaluate(() => (document.body.innerText.match(/\(T\)/g) || []).length);

const cases = [
  { label: "practical-experience manage", path: `/admin/line-opening/practical-experience?org=${ORG}&tab=manage` },
  { label: "practical-experience open", path: `/admin/line-opening/practical-experience?org=${ORG}&tab=open` },
  { label: "process-check experience", path: `/admin/processes/check/experience?org=${ORG}` },
];

try {
  for (const c of cases) {
    // operating
    await goto(c.path);
    const opT = await countTeamT();
    ck(`[operating] ${c.label} (T) 0건`, opT === 0, `count=${opT}`);
    // test
    await goto(`${c.path}&mode=test`);
    const tT = await countTeamT();
    ck(`[test] ${c.label} (T) 노출`, tT >= 1, `count=${tT}`);
  }
  await page.screenshot({
    path: resolve(adminRoot, "claudedocs", "browser-teams-scope-test.png"),
    fullPage: false,
  });
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try {
    await page.screenshot({
      path: resolve(adminRoot, "claudedocs", "browser-teams-scope-error.png"),
      fullPage: true,
    });
  } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
