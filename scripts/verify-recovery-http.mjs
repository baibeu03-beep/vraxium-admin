// 복구 후 실제 HTTP 검증 — 대표 사용자 20명+ 로 전 표면의 A/B/C 동일성을 확인한다.
//   사전: admin dev 서버 기동. 기본 http://localhost:3000 (VERIFY_BASE 로 변경 가능)
//   Usage: node scripts/verify-recovery-http.mjs [label]
//
// 기대값 = lib/pointResolver.ts 규칙(user_weekly_points 전체기간 합)을 DB 에서 직접 계산한 값.
//   A = Σpoints · rawAdvantage = Σadvantages · C = Σ|penalty| · B = rawAdvantage − C
// 표면이 이 값과 다르면 실패. 일반 모드와 mode=test 가 다르면 실패. C 가 음수면 실패.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const BASE = process.env.VERIFY_BASE || "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const INTERNAL = get("INTERNAL_API_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const label = process.argv[2] || "after";

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

async function cookieHeader(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function pageAll(build) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build(f, f + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const j = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body };
};

async function main() {
  // ── 기대값: pointResolver 규칙으로 DB 직접 산출 ──
  const uwp = await pageAll((f, t) => sb.from("user_weekly_points").select("user_id,points,advantages,penalty").order("id").range(f, t));
  const expect = new Map();
  for (const r of uwp) {
    const e = expect.get(r.user_id) ?? { A: 0, raw: 0, C: 0 };
    e.A += r.points ?? 0; e.raw += r.advantages ?? 0; e.C += Math.abs(r.penalty ?? 0);
    expect.set(r.user_id, e);
  }
  for (const e of expect.values()) e.B = e.raw - e.C;

  const profs = new Map((await pageAll((f, t) => sb.from("user_profiles").select("user_id,display_name,organization_slug").order("user_id").range(f, t))).map((p) => [p.user_id, p]));
  const markers = new Set((await pageAll((f, t) => sb.from("test_user_markers").select("user_id").order("user_id").range(f, t))).map((m) => m.user_id));
  const legacyOf = new Map((await pageAll((f, t) => sb.from("users").select("id,legacy_user_id").order("id").range(f, t))).map((u) => [u.id, u.legacy_user_id]));

  // ── 대표 사용자: sample20 산출물 + 테스트 계정 보강 ──
  const sampleFile = "claudedocs/" + readdirSync(resolve(adminRoot, "claudedocs")).filter((x) => x.startsWith("recover-uwp-sample20-") && x.endsWith(".json")).sort().pop();
  const sample = JSON.parse(readFileSync(resolve(adminRoot, sampleFile), "utf8"));
  const USERS = sample.map((s) => ({ id: s.user_id, name: s.사용자, cat: s.카테고리, org: s.org }));
  // 테스트 계정 2명 추가(일반 vs mode=test 동일성 확인용)
  for (const uid of [...markers].slice(0, 2)) {
    if (USERS.some((u) => u.id === uid)) continue;
    USERS.push({ id: uid, name: profs.get(uid)?.display_name ?? uid.slice(0, 8), cat: "테스트 계정", org: profs.get(uid)?.organization_slug ?? "?" });
  }
  console.log(`대표 사용자 ${USERS.length}명 (원천 ${sampleFile}) · BASE=${BASE}`);

  const cookie = await cookieHeader(OWNER_EMAIL);
  const admin = { headers: { cookie } };
  const out = { label, base: BASE, users: {} };
  let fail = 0;

  const rosterCache = new Map();
  async function roster(org, mode) {
    const key = `${org}|${mode}`;
    if (rosterCache.has(key)) return rosterCache.get(key);
    const r = await j(`/api/admin/members/roster?organization=${org}&pageSize=300${mode ? `&mode=${mode}` : ""}`, admin);
    const rows = r.body?.data?.members ?? r.body?.members ?? [];
    rosterCache.set(key, rows);
    return rows;
  }

  for (const u of USERS) {
    const exp = expect.get(u.id) ?? { A: 0, raw: 0, C: 0, B: 0 };
    const rec = { name: u.name, cat: u.cat, org: u.org, expect: exp, screens: {} };
    void legacyOf;

    // 1) Cluster3 stats-cards (일반 / mode=test)
    for (const mode of ["", "&mode=test"]) {
      const r = await j(`/api/cluster3/stats-cards?userId=${u.id}${mode}`, { headers: { "x-internal-api-key": INTERNAL } });
      const p = r.body?.data?.points ?? r.body?.points ?? null;
      rec.screens[`cluster3${mode ? ":test" : ""}`] = p ? { A: p.totalStars, B: p.totalShields, C: p.totalLightning } : { _status: r.status };
    }
    // 2) 관리자 Cluster3 growth  (crews 라우트 param 은 legacy_user_id 이름이지만 실제로는 user_id UUID)
    {
      const r = await j(`/api/admin/crews/${u.id}/cluster3/growth`, admin);
      const p = r.body?.data?.point ?? r.body?.point ?? null;
      rec.screens.adminGrowth = p ? { A: p.points, B: p.netAdvantages, C: p.penalty, raw: p.rawAdvantages } : { _status: r.status };
    }
    // 3) 회원 상세 (일반 / mode=test)
    for (const mode of ["", "?mode=test"]) {
      const r = await j(`/api/admin/members/${u.id}${mode}`, admin);
      const c = r.body?.data?.clubSummary ?? r.body?.clubSummary ?? null;
      rec.screens[`memberDetail${mode ? ":test" : ""}`] = c ? { A: c.poA, B: c.poB, C: c.poC } : { _status: r.status };
    }
    // 4) 관리자 이력서 카드 (= 크루 이력서 카드 canonical)
    {
      const r = await j(`/api/admin/crews/${u.id}/resume-card`, admin);
      const c = r.body?.data?.computed ?? r.body?.computed ?? null;
      rec.screens.resumeCard = c ? { A: c.totalStars, B: c.totalShields, C: c.totalPointC, C_compat: c.totalLightnings } : { _status: r.status };
      // 5) 크루 카드(resume graft)
      const r2 = await j(`/api/admin/crews/${u.id}/resume-card/resume`, admin);
      const c2 = r2.body?.data?.computed ?? r2.body?.computed ?? r2.body?.data?.card ?? null;
      if (c2) rec.screens.crewCard = { A: c2.totalStars ?? c2.pointA, B: c2.totalShields ?? c2.pointB, C: c2.totalPointC ?? c2.pointC };
    }
    // 6) roster slim
    {
      const rows = await roster(u.org, "");
      const row = rows.find((x) => x.userId === u.id || x.user_id === u.id);
      if (row) rec.screens.rosterSlim = { A: row.poA, B: row.poB, C: row.poC };
    }

    // ── 판정 ──
    const issues = [];
    for (const [k, v] of Object.entries(rec.screens)) {
      if (v.A === undefined) { issues.push(`${k}:응답없음(${v._status})`); continue; }
      if (v.A !== exp.A) issues.push(`${k}:A ${v.A}≠${exp.A}`);
      if (v.B !== exp.B) issues.push(`${k}:B ${v.B}≠${exp.B}`);
      if (v.C !== exp.C) issues.push(`${k}:C ${v.C}≠${exp.C}`);
      if (v.C < 0) issues.push(`${k}:C 음수`);
    }
    const g = rec.screens.cluster3, t = rec.screens["cluster3:test"];
    if (g && t && g.A !== undefined && t.A !== undefined && (g.A !== t.A || g.B !== t.B || g.C !== t.C)) issues.push("일반≠mode=test(cluster3)");
    const m1 = rec.screens.memberDetail, m2 = rec.screens["memberDetail:test"];
    if (m1 && m2 && m1.A !== undefined && m2.A !== undefined && (m1.A !== m2.A || m1.B !== m2.B || m1.C !== m2.C)) issues.push("일반≠mode=test(회원상세)");
    rec.issues = issues;
    if (issues.length) fail++;
    out.users[u.id] = rec;
  }

  writeFileSync(resolve(__dirname, `_recovery-http-${label}.json`), JSON.stringify(out, null, 2), "utf8");

  console.log(`\n| 사용자 | 원장 기대 A/B/C | Cluster3 | 회원상세 | 관리자 이력서 | 크루 카드 | roster slim | adminGrowth | 판정 |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  const fmt = (v) => (v && v.A !== undefined ? `${v.A}/${v.B}/${v.C}` : v ? `(${v._status})` : "-");
  for (const u of USERS) {
    const r = out.users[u.id];
    console.log(`| ${r.name} | ${r.expect.A}/${r.expect.B}/${r.expect.C} | ${fmt(r.screens.cluster3)} | ${fmt(r.screens.memberDetail)} | ${fmt(r.screens.resumeCard)} | ${fmt(r.screens.crewCard)} | ${fmt(r.screens.rosterSlim)} | ${fmt(r.screens.adminGrowth)} | ${r.issues.length ? "❌ " + r.issues.slice(0, 2).join(" / ") : "✅"} |`);
  }
  console.log(`\n대상 ${USERS.length}명 · 실패 ${fail}명`);
  console.log(`saved → scripts/_recovery-http-${label}.json`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
