// 시즌 휴식자 후보 제외 검증 (실제 HTTP · GET only) — 2026-07-27 R1/R2
//   R1 /api/admin/cluster4/crews · R2 /api/admin/cluster4/cafe-line-crew
//   기준 시즌 = week_id 가 속한 시즌(현재 시즌 고정 아님).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(resolve(root, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const { createServerClient } = req("@supabase/ssr");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const sb = createClient(g("NEXT_PUBLIC_SUPABASE_URL"), g("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const J = (v) => JSON.stringify(v);

const { data: adm } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
const b = createClient(g("NEXT_PUBLIC_SUPABASE_URL"), g("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: adm[0].email });
const { data: v } = await b.auth.verifyOtp({ email: adm[0].email, token: l.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(g("NEXT_PUBLIC_SUPABASE_URL"), g("NEXT_PUBLIC_SUPABASE_ANON_KEY"), { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const COOKIE = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (p) => { const r = await fetch(`${BASE}${p}`, { headers: { cookie: COOKIE }, cache: "no-store" }); let j = null; try { j = await r.json(); } catch {} return { status: r.status, json: j }; };

const ORG = "encre";
const REST_USER = "614f78f4-c372-4c11-a17f-46b9e7bd4523"; // 2026-spring:rest, 2026-summer:rest
const { data: mk } = await sb.from("test_user_markers").select("user_id").limit(1);
const ACT_AS = mk?.[0]?.user_id ?? null;
const PATHS = [{ n: "operating", q: "" }, { n: "test", q: "&mode=test" }, ...(ACT_AS ? [{ n: "test+actAs", q: `&mode=test&actAsTestUserId=${ACT_AS}` }] : [])];

const { data: weeks } = await sb.from("weeks").select("id,start_date,season_key").lte("start_date", new Date().toISOString().slice(0, 10)).order("start_date", { ascending: false }).limit(30);
const cur = weeks[0];
const springWeek = weeks.find((w) => w.season_key !== cur.season_key) ?? null;
console.log(`현재 주차 ${cur.start_date}/${cur.season_key} · 과거 시즌 주차 ${springWeek ? `${springWeek.start_date}/${springWeek.season_key}` : "(없음)"}`);
console.log(`대상 = ${REST_USER.slice(0,8)} (2026-spring:rest, 2026-summer:rest)\n`);

console.log("═══ R1 /api/admin/cluster4/crews ═══");
const r1 = [];
for (const p of PATHS) {
  const noWeek = await api(`/api/admin/cluster4/crews?organization=${ORG}&status=active${p.q}`);
  const withCur = await api(`/api/admin/cluster4/crews?organization=${ORG}&status=active&week_id=${cur.id}${p.q}`);
  const ids0 = (noWeek.json?.data ?? []).map((c) => c.userId);
  const ids1 = (withCur.json?.data ?? []).map((c) => c.userId);
  console.log(`  [${p.n}] week 미전달 ${ids0.length}명 / 현재주차 ${ids1.length}명`);
  ck(`[${p.n}] 200`, noWeek.status === 200 && withCur.status === 200, `${noWeek.status}/${withCur.status}`);
  ck(`[${p.n}] 시즌 휴식자 제외(week 미전달=현재 시즌 폴백)`, !ids0.includes(REST_USER));
  ck(`[${p.n}] 시즌 휴식자 제외(현재 주차 명시)`, !ids1.includes(REST_USER));
  ck(`[${p.n}] 두 호출 동일 집합`, J([...ids0].sort()) === J([...ids1].sort()), `${ids0.length} vs ${ids1.length}`);
  r1.push(J([...ids1].sort()));
  if (withCur.json?.data?.[0]) ck(`[${p.n}] DTO 키 유지`, J(Object.keys(withCur.json.data[0])) === J(["userId","displayName","crewNo","profileImg","organization","teamName","partName","membershipLevel","membershipState"]), J(Object.keys(withCur.json.data[0])));
}
ck("R1 3경로 동일 집합(actor 무관)", new Set(r1).size === 1);

console.log("\n═══ R2 /api/admin/cluster4/cafe-line-crew (excludeSeasonRest=1) ═══");
const r2 = [];
for (const p of PATHS) {
  const r = await api(`/api/admin/cluster4/cafe-line-crew?organization=${ORG}&excludeSeasonRest=1&week_id=${cur.id}${p.q}`);
  const ids = (r.json?.data?.crews ?? r.json?.data ?? []).map((c) => c.userId ?? c);
  console.log(`  [${p.n}] status=${r.status} ${ids.length}명`);
  ck(`[${p.n}] 200`, r.status === 200, String(r.status));
  ck(`[${p.n}] 시즌 휴식자 제외`, !ids.includes(REST_USER));
  r2.push(J([...ids].sort()));
}
ck("R2 3경로 동일 집합", new Set(r2).size === 1);

console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
process.exit(fail > 0 ? 1 : 0);
