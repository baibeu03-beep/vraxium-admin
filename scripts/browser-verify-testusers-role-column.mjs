// 검증(브라우저) — /admin/test-users '역할' 컬럼(팀장/파트장/에이전트/일반).
//   1) 역할 컬럼 헤더 존재
//   2) team_leader/part_leader/agent/member 행이 각각 팀장/파트장/에이전트/일반으로 표시
//   3) 일반(member) 행에는 '어드민 페이지로 보기' 미표시 / 4) 그 외엔 표시
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

// 역할별 테스트 유저 1명씩(이름 + 기대 라벨).
async function samples() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((m) => m.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,role").in("user_id", ids);
  const pById = new Map((profs ?? []).map((p) => [p.user_id, p]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,membership_level,is_current").in("user_id", ids);
  const cur = new Map(); for (const m of (mems ?? [])) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  const norm = (role, lv) => role === "team_leader" ? "team_leader" : (lv ?? "").startsWith("심화") ? (role === "part_leader" ? "part_leader" : "agent") : "member";
  const want = { team_leader: "팀장", part_leader: "파트장", agent: "에이전트", member: "일반" };
  const out = {};
  for (const id of ids) { const p = pById.get(id); const m = cur.get(id); if (!p || !m) continue; const r = norm(p.role, m.membership_level); if (!out[r]) out[r] = { name: p.display_name, label: want[r] }; }
  return out;
}

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const s = await samples();
console.log("  samples:", Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.name}=${v.label}`])));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 이름 행의 셀 텍스트 배열 + 어드민 버튼 존재.
const rowInfo = (name) => page.evaluate((name) => {
  const row = [...document.querySelectorAll("tbody tr")].find((tr) => tr.textContent?.includes(name));
  if (!row) return null;
  const cells = [...row.querySelectorAll("td")].map((td) => (td.textContent || "").trim());
  const adminBtn = [...row.querySelectorAll("button")].some((b) => /어드민 페이지로 보기/.test(b.textContent || ""));
  return { cells, adminBtn };
}, name);

try {
  await page.goto(`${BASE}/admin/test-users`, { waitUntil: "networkidle" });
  const anyName = Object.values(s)[0]?.name;
  if (anyName) await page.waitForFunction((n) => [...document.querySelectorAll("tbody tr")].some((tr) => (tr.textContent || "").includes(n)), anyName, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);

  // 1) 헤더 순서 — 팀/파트/역할/등급 인접 확인.
  const headers = await page.evaluate(() => [...document.querySelectorAll("thead th")].map((th) => (th.textContent || "").trim()));
  ck("[1] '역할' 컬럼 헤더 존재", headers.includes("역할"), headers.join("|"));
  ck("[1] 역할 컬럼이 파트 다음", headers.indexOf("역할") === headers.indexOf("파트") + 1, headers.join("|"));

  // 2) 역할 라벨(역할 컬럼=index of 역할) 일치.
  const roleIdx = headers.indexOf("역할");
  for (const [role, info] of Object.entries(s)) {
    const r = await rowInfo(info.name);
    const cell = r?.cells?.[roleIdx];
    ck(`[2] ${role}(${info.name}) → 역할='${info.label}'`, cell === info.label, `표시=${cell}`);
  }

  // 3·4) 어드민 버튼 노출.
  if (s.member) { const r = await rowInfo(s.member.name); ck("[3] 일반(member) 행 어드민 버튼 미표시", r?.adminBtn === false); }
  for (const role of ["team_leader", "part_leader", "agent"]) {
    if (s[role]) { const r = await rowInfo(s[role].name); ck(`[4] ${role} 행 어드민 버튼 표시`, r?.adminBtn === true); }
  }

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-testusers-role-column.png"), fullPage: false });
  console.log("  screenshot → claudedocs/browser-testusers-role-column.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
