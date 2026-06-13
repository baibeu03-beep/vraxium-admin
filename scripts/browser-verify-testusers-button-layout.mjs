// 검증(브라우저) — /admin/test-users 버튼 1행 2열 가로 배치(어드민 왼쪽·고객 오른쪽).
//   1) team_leader/part_leader/agent 행: 두 버튼이 같은 줄(동일 top, 어드민 left < 고객 left)
//   2) 어드민 버튼이 왼쪽 / 고객 버튼이 오른쪽
//   3) crew 행: 고객 버튼만(어드민 없음) — 기존 동작 유지
// read-only.
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

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 임퍼소네이션 가능 역할 1명 + crew 1명 이름 찾기.
async function names() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((m) => m.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,role").in("user_id", ids);
  const pById = new Map((profs ?? []).map((p) => [p.user_id, p]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,membership_level,is_current").in("user_id", ids);
  const cur = new Map(); for (const m of (mems ?? [])) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  const norm = (role, lv) => role === "team_leader" ? "team_leader" : (lv ?? "").startsWith("심화") ? (role === "part_leader" ? "part_leader" : "agent") : "member";
  let imp = null, crew = null;
  for (const id of ids) { const p = pById.get(id); const m = cur.get(id); if (!p || !m) continue; const r = norm(p.role, m.membership_level); if (!imp && r !== "member") imp = p.display_name; if (!crew && r === "member") crew = p.display_name; }
  return { imp, crew };
}

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const { imp, crew } = await names();
console.log("  sample:", { imp, crew });

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 이름 행에서 두 버튼의 위치(rect) 반환.
const rects = (name) => page.evaluate((name) => {
  const row = [...document.querySelectorAll("tr")].find((tr) => tr.textContent?.includes(name));
  if (!row) return null;
  const btns = [...row.querySelectorAll("button")];
  const find = (label) => { const b = btns.find((x) => (x.textContent || "").includes(label)); return b ? b.getBoundingClientRect() : null; };
  const admin = find("어드민 페이지로 보기"), cust = find("고객 페이지로 보기");
  return {
    admin: admin ? { left: Math.round(admin.left), top: Math.round(admin.top) } : null,
    cust: cust ? { left: Math.round(cust.left), top: Math.round(cust.top) } : null,
  };
}, name);

try {
  await page.goto(`${BASE}/admin/test-users`, { waitUntil: "networkidle" });
  // 특정 임퍼 유저 행이 렌더될 때까지 대기(테이블 hydrate 보장).
  if (imp) {
    await page.waitForFunction(
      (n) => [...document.querySelectorAll("tr")].some((tr) => (tr.textContent || "").includes(n)),
      imp,
      { timeout: 30000 },
    ).catch(() => {});
  }
  await page.waitForTimeout(800);

  if (imp) {
    const r = await rects(imp);
    ck("[1] 임퍼 행: 두 버튼 모두 존재", Boolean(r?.admin && r?.cust), JSON.stringify(r));
    if (r?.admin && r?.cust) {
      ck("[1] 두 버튼 같은 줄(top 동일·±4px)", Math.abs(r.admin.top - r.cust.top) <= 4, `admin.top=${r.admin.top} cust.top=${r.cust.top}`);
      ck("[2] 어드민 버튼이 왼쪽", r.admin.left < r.cust.left, `admin.left=${r.admin.left} cust.left=${r.cust.left}`);
      ck("[3] 고객 버튼이 오른쪽", r.cust.left > r.admin.left);
    }
  }
  if (crew) {
    const r = await rects(crew);
    ck("[4] crew 행: 어드민 버튼 없음·고객 버튼만(기존 동작 유지)", Boolean(r?.cust) && !r?.admin, JSON.stringify(r));
  }
  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-testusers-button-layout.png"), fullPage: false });
  console.log("  screenshot → claudedocs/browser-testusers-button-layout.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
