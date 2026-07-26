// 누적 A/B/C 회귀 복구 — 실제 HTTP 검증 (dev :3000, owner 세션 + internal key).
//   Cluster3 stats-cards / 관리자 growth / 회원 상세(클럽 결과 종합) /
//   회원 목록 roster slim / 관리자·크루 이력서 카드 를 같은 사용자로 호출해
//   A/B/C 가 전부 동일한지, C 가 항상 양수인지, 일반==mode=test 인지 본다.
//
//   Usage: node scripts/verify-point-abc-http.mjs [before|after]
//   결과는 scripts/_point-abc-<label>.json 으로 저장 → 두 파일을 비교한다.
import { readFileSync, writeFileSync } from "node:fs";
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

const BASE = process.env.VERIFY_BASE || "http://localhost:3012";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const INTERNAL = get("INTERNAL_API_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const label = process.argv[2] || "run";

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

async function cookieHeader(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── 검증 대상 사용자 (§2 요구 카테고리 전부 포함) ─────────────────────
// uwp = user_weekly_points 전체합(= 회귀 전 화면 기대값), ppa = awards-only(= 회귀 후 값)
const USERS = [
  { id: "76a42307-f3b2-4c08-92ab-f339a20b7d38", name: "T윤서진", cat: "예시 사용자·테스트·penalty·3자리A", org: "encre", test: true },
  { id: "9e2f8097-b1ce-4920-9c67-af9989074cfd", name: "T홍채원", cat: "예시 사용자(동일 20/-18/18)·테스트", org: "encre", test: true },
  { id: "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", name: "윤채영", cat: "PMS 레거시 최다·일반·penalty·3자리A", org: "encre", test: false },
  { id: "d23a3e0a-c716-4c4d-8d70-5baabe3a0690", name: "송선우", cat: "PMS 레거시·일반·3자리A", org: "encre", test: false },
  { id: "eb15f3f3-6a37-4890-933c-24582efe6897", name: "안재민", cat: "PMS 레거시·일반·penalty", org: "encre", test: false },
  { id: "05ff6b96-b3e7-4050-97f1-080633f183d3", name: "T권희윤", cat: "최근 awards 있음·두 원천 상이 최대", org: "phalanx", test: true },
  { id: "42864260-e4ea-4150-a87f-cff545b02af1", name: "T이보영", cat: "최근 awards 있음·두 원천 상이", org: "encre", test: true },
  { id: "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", name: "T장시현", cat: "최근 awards 있음·penalty 큼", org: "phalanx", test: true },
  { id: "00b75923-2109-4214-806a-37667d64ac5e", name: "T강민지", cat: "두 원천 값 동일(변화 없어야 함)", org: "phalanx", test: true },
  { id: "3fec1a7e-4a88-4bc7-8da8-9eb9daff6f8a", name: "T범혜민", cat: "두 원천 동일·penalty 0", org: "phalanx", test: true },
  { id: "3d968dba-77a4-4382-a5ad-ad5cad7c1c34", name: "T이선호", cat: "두 원천 동일·penalty 소량", org: "oranke", test: true },
  { id: "f6b94575-a472-47a8-a20c-535b86bd2c4c", name: "(음수 A)", cat: "레거시 음수 A 코호트", org: null, test: false },
];

const j = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { _raw: text.slice(0, 300) }; }
  return { status: res.status, body };
};

async function main() {
  const cookie = await cookieHeader(OWNER_EMAIL);
  const admin = { headers: { cookie } };
  const out = { label, users: {} };

  for (const u of USERS) {
    const rec = { name: u.name, cat: u.cat, screens: {} };

    // 1) Cluster3 stats-cards (고객 canonical · internal key 경로)
    for (const mode of ["", "&mode=test"]) {
      const key = `cluster3StatsCards${mode ? ":test" : ""}`;
      const r = await j(`/api/cluster3/stats-cards?userId=${u.id}${mode}`, {
        headers: { "x-internal-api-key": INTERNAL },
      });
      const p = r.body?.data?.points ?? r.body?.points ?? null;
      rec.screens[key] = p
        ? { A: p.totalStars, B: p.totalShields, C: p.totalLightning }
        : { _status: r.status, _err: r.body?.error ?? null };
    }

    // 2) 관리자 Cluster3 growth (같은 getGrowthIndicators)
    {
      const r = await j(`/api/admin/crews/${u.id}/cluster3/growth`, admin);
      const p = r.body?.data?.point ?? r.body?.point ?? null;
      rec.screens.adminGrowth = p
        ? { A: p.points, B: p.netAdvantages, C: p.penalty, raw: p.rawAdvantages }
        : { _status: r.status, _err: r.body?.error ?? null };
    }

    // 3) /admin/members 회원 상세 — 클럽 결과(종합)
    for (const mode of ["", "?mode=test"]) {
      const key = `memberDetail${mode ? ":test" : ""}`;
      const r = await j(`/api/admin/members/${u.id}${mode}`, admin);
      const c = r.body?.data?.clubSummary ?? r.body?.clubSummary ?? null;
      rec.screens[key] = c
        ? { A: c.poA, B: c.poB, C: c.poC }
        : { _status: r.status, _err: r.body?.error ?? null };
    }

    // 4) 관리자 이력서 카드 (크루 이력서 카드도 이 admin canonical API 를 호출)
    {
      const r = await j(`/api/admin/crews/${u.id}/resume-card`, admin);
      const c = r.body?.data?.computed ?? r.body?.computed ?? null;
      rec.screens.resumeCard = c
        ? {
            A: c.totalStars,
            B: c.totalShields,
            C: c.totalPointC,
            C_compat: c.totalLightnings,
            raw: c.rawAdvantage ?? null,
          }
        : { _status: r.status, _err: r.body?.error ?? null };
    }

    out.users[u.id] = rec;
  }

  // 5) roster slim 목록 — 조직별 1회 호출 후 대상 사용자 행만 추출
  for (const [org, mode] of [["encre", ""], ["phalanx", ""], ["oranke", ""], ["encre", "test"]]) {
    const key = `roster:${org}${mode ? ":test" : ""}`;
    const r = await j(
      `/api/admin/members/roster?organization=${org}&pageSize=200${mode ? `&mode=${mode}` : ""}`,
      admin,
    );
    const rows = r.body?.data?.members ?? r.body?.members ?? [];
    for (const u of USERS) {
      const row = rows.find((x) => x.userId === u.id || x.user_id === u.id);
      if (!row) continue;
      out.users[u.id].screens[key] = { A: row.poA, B: row.poB, C: row.poC };
    }
    if (!out._roster) out._roster = {};
    out._roster[key] = { status: r.status, rowCount: rows.length };
  }

  writeFileSync(
    resolve(__dirname, `_point-abc-${label}.json`),
    JSON.stringify(out, null, 2),
    "utf8",
  );

  // 콘솔 요약표
  console.log(`\n=== ${label.toUpperCase()} ===`);
  for (const u of USERS) {
    const rec = out.users[u.id];
    console.log(`\n[${rec.name}] ${rec.cat}`);
    for (const [screen, v] of Object.entries(rec.screens)) {
      const shown =
        v.A === undefined ? JSON.stringify(v) : `A=${v.A} B=${v.B} C=${v.C}${v.C_compat !== undefined ? ` C_compat=${v.C_compat}` : ""}`;
      console.log(`   ${screen.padEnd(26)} ${shown}`);
    }
  }
  console.log("\nroster fetch:", JSON.stringify(out._roster));
  console.log(`\nsaved → scripts/_point-abc-${label}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
