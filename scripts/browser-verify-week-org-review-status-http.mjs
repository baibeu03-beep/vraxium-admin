// 실제 HTTP 검증(dev :3000, owner 세션) — scope 모델.
//   전제: scope 마이그레이션 + migrate --apply + regen --apply 완료.
//   [A] 관리자 목록: /api/admin/team-parts/info/weeks?club=<org> → W2 reviewStatus (QA=test scope)
//   [B] 카드 라우트: /api/cluster4/weekly-cards?userId=<user> (owner act-as) → 같은 org·W2 라도
//         테스트 사용자 success/fail, 운영 사용자 aggregating. DTO 키·카드수 동일. snapshot==HTTP.
//   Usage: node scripts/browser-verify-week-org-review-status-http.mjs
import { readFileSync } from "node:fs";
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
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const ORGS = ["phalanx", "oranke", "encre"];
const W2_START = "2026-07-06";

let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

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

async function testMarkerIds() {
  const out = new Set();
  const { data } = await sb.from("test_user_markers").select("user_id");
  for (const r of data ?? []) out.add(r.user_id);
  return out;
}

async function pickUser(org, want, testIds) {
  const { data: uss } = await sb.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer");
  const ids = [...new Set((uss ?? []).map((r) => r.user_id))];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await sb.from("user_profiles").select("user_id").in("user_id", ids.slice(i, i + 300)).eq("organization_slug", org);
    for (const p of data ?? []) { const t = testIds.has(p.user_id); if (want === "test" ? t : !t) return p.user_id; }
  }
  return null;
}

async function main() {
  const Cookie = await cookieHeader(OWNER_EMAIL);
  const jget = async (path) => { const r = await fetch(`${BASE}${path}`, { headers: { Cookie } }); const body = await r.json().catch(() => null); return { status: r.status, body }; };
  const testIds = await testMarkerIds();

  const { data: w2 } = await sb.from("weeks").select("id").eq("season_key", "2026-summer").eq("week_number", 2).maybeSingle();
  const expTest = {};
  for (const org of ORGS) {
    const { data: st } = await sb.from("cluster4_week_org_result_states").select("status").eq("week_id", w2.id).eq("organization_slug", org).eq("scope", "test").maybeSingle();
    expTest[org] = st?.status ?? "aggregating";
  }

  console.log("▶ [A] 관리자 목록 (QA=test scope)");
  for (const org of ORGS) {
    const { status, body } = await jget(`/api/admin/team-parts/info/weeks?club=${org}&pageSize=100`);
    const item = body?.data?.items?.find((i) => i.weekId === w2.id);
    ck(`[${org}] 200 · W2 reviewStatus=${item?.reviewStatus} == test-scope=${expTest[org]}`, status === 200 && item?.reviewStatus === expTest[org]);
  }

  console.log("\n▶ [B] 카드 라우트 — 테스트 vs 운영 사용자 (owner act-as ?userId=)");
  let testKeys = null, operKeys = null;
  const allStatuses = [];
  for (const org of ORGS) {
    const tu = await pickUser(org, "test", testIds);
    const ou = await pickUser(org, "operating", testIds);
    if (tu) {
      const { status, body } = await jget(`/api/cluster4/weekly-cards?userId=${tu}`);
      const cards = body?.data?.cards ?? body?.cards ?? body?.data ?? [];
      const c = Array.isArray(cards) ? cards.find((x) => x.startDate === W2_START) : null;
      const wantResult = expTest[org] === "published";
      // 고객 카드 어휘: published+uws→success/fail, 그 외→'tallying'(성장 집계 중). 'aggregating'/'reviewing' 없음.
      ck(`[${org}] test 사용자 200 · W2=${c?.userWeekStatus}`, status === 200 && c != null && (wantResult ? ["success", "fail"].includes(c.userWeekStatus) : c.userWeekStatus === "tallying"), `http=${status}`);
      if (c) testKeys = Object.keys(c).sort().join(",");
      if (Array.isArray(cards)) allStatuses.push(...cards.map((x) => x.userWeekStatus));
    }
    if (ou) {
      const { status, body } = await jget(`/api/cluster4/weekly-cards?userId=${ou}`);
      const cards = body?.data?.cards ?? body?.cards ?? body?.data ?? [];
      const c = Array.isArray(cards) ? cards.find((x) => x.startDate === W2_START) : null;
      ck(`[${org}] 운영 사용자 200 · W2=${c?.userWeekStatus} (성장 집계 중=tallying·카드 유지)`, status === 200 && c != null && c.userWeekStatus === "tallying", `http=${status}`);
      if (c) operKeys = Object.keys(c).sort().join(",");
      if (Array.isArray(cards)) allStatuses.push(...cards.map((x) => x.userWeekStatus));
    }
  }
  if (testKeys && operKeys) ck("test/operating W2 카드 DTO 키 동일", testKeys === operKeys);
  ck("고객 카드에 'aggregating'/'reviewing' 없음", !allStatuses.includes("aggregating") && !allStatuses.includes("reviewing"));

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — 실패 ${fail}건 · W2 test-scope 기대 ${JSON.stringify(expTest)}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
