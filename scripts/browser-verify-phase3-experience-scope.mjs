// 검증(브라우저) — Phase 3: 실무 경험 [라인 관리] 보드 mode 스코프.
//   브라우저가 실제로 보낸 /experience/line-manage 응답을 캡처해 검증(컴포넌트가 mode 전파했는지 + 렌더 데이터).
//   operating(?org=oranke) → 운영 팀만·(T) 없음. test(&mode=test) → (T) 팀만·인원 9/7/11·역할 비-0.
//   read-only. snapshot 무접촉.
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
const EMAIL = "vanuatu.golden@gmail.com", ORG = "oranke";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2600 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 가장 최근 line-manage 응답을 보관.
let lastLineManage = null;
page.on("response", async (res) => {
  if (res.url().includes("/api/admin/cluster4/experience/line-manage")) {
    try { lastLineManage = { url: res.url(), json: await res.json() }; } catch {/* skip */}
  }
});
async function gotoAndCapture(url) {
  lastLineManage = null;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30 && !lastLineManage; i++) await page.waitForTimeout(500);
  return lastLineManage;
}

try {
  // ── operating ──
  const op = await gotoAndCapture(`${BASE}/admin/line-opening/practical-experience?org=${ORG}`);
  ck("[operating] 보드가 line-manage 호출", !!op, op?.url);
  ck("[operating] 요청에 mode=test 없음", !!op && !op.url.includes("mode=test"));
  const opTeams = (op?.json?.data?.teams ?? []).map((t) => t.teamName);
  ck("[operating] 운영 팀(F&B) 카드 데이터", opTeams.includes("F&B"), `teams=${opTeams.join(",")}`);
  ck("[operating] (T) 테스트 팀 없음", !opTeams.some((t) => /\(T\)$/.test(t)));
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phase3-operating.png"), fullPage: true });

  // ── test ──
  const ts = await gotoAndCapture(`${BASE}/admin/line-opening/practical-experience?org=${ORG}&mode=test`);
  ck("[test] 보드가 line-manage 호출", !!ts);
  ck("[test] 요청에 mode=test 전파됨", !!ts && ts.url.includes("mode=test"), ts?.url);
  const tsTeams = (ts?.json?.data?.teams ?? []);
  const tsNames = tsTeams.map((t) => t.teamName);
  ck("[test] 테스트 팀만(과일(T)/음료(T)/콘텐츠실험(T))",
    tsNames.length === 3 && ["과일(T)", "음료(T)", "콘텐츠실험(T)"].every((t) => tsNames.includes(t)), `teams=${tsNames.join(",")}`);
  ck("[test] 운영 팀(F&B) 없음", !tsNames.includes("F&B"));
  const expect = { "과일(T)": 9, "음료(T)": 7, "콘텐츠실험(T)": 11 };
  for (const [team, n] of Object.entries(expect)) {
    const t = tsTeams.find((x) => x.teamName === team);
    ck(`[test] ${team} 인원 ${n}명(비-0)`, t?.headcount?.total === n, `total=${t?.headcount?.total}`);
  }
  const fruit = tsTeams.find((x) => x.teamName === "과일(T)");
  ck("[test] 과일(T) 역할 비-0(파트장·에이전트>0)", !!fruit && fruit.headcount.partLeader > 0 && fruit.headcount.agent > 0,
    fruit && `일반${fruit.headcount.normal}/파트장${fruit.headcount.partLeader}/에이전트${fruit.headcount.agent}`);
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phase3-test.png"), fullPage: true });

  console.log("  screenshots → claudedocs/browser-phase3-{operating,test}.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-phase3-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
