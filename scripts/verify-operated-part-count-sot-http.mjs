// 운용 파트 수 SoT 통일 검증 (실제 HTTP) — 2026-07-27 C1/C2
//
//   node --dns-result-order=ipv4first scripts/verify-operated-part-count-sot-http.mjs
//
// C1: 팀 상세 상단 operatedPartCount == [A] 선택 주차 요약 operatedParts.length
// C2: 클럽 요약 partCount == Σ 팀별 <운용> 파트('일반' 제외 = listOperatedTeamParts).length
//     + 행 합계 == totals.partCount == structureTotals.totalParts 불변식
// 파리티: operating / test / test+actAsTestUserId — 같은 수·같은 DTO 키·타입
//
// 읽기 전용(GET only). 데이터 변경 없음.
// ⚠ 호출 수 주의: team-detail·week-summary·summary 모두 주차 effective 계산을 타는 무거운 엔드포인트다.
//   기대값(팀별 운용 파트)은 **한 mode 당 1회만** 계산하고 경로 간에는 재사용한다(파리티는 별도 단언).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(SUPABASE_URL, get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const ORGS = ["encre", "oranke", "phalanx"];
const FOCUS_ORG = "encre";
const FOCUS_TEAM = "비주얼랩(T)";
const DEFAULT_PART = "일반";

let pass = 0;
let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const J = (v) => JSON.stringify(v);

let COOKIE = "";
async function makeAdminCookie() {
  const { data: adm } = await sb
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  console.log(`admin = ${adminEmail}`);
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie: COOKIE } });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

const modeQs = (mode, actAs) =>
  `${mode === "test" ? "&mode=test" : ""}${actAs ? `&actAsTestUserId=${actAs}` : ""}`;
const teamDetail = (org, halfId, mode, actAs) =>
  api(`/api/admin/team-parts/info/team-detail?organization=${org}&teamHalfId=${halfId}${modeQs(mode, actAs)}`);
const weekSummary = (org, halfId, mode, actAs) =>
  api(`/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${halfId}${modeQs(mode, actAs)}`);
const clubSummary = (mode, actAs) =>
  api(`/api/admin/team-parts/info/summary?_=1${modeQs(mode, actAs)}`);
// 현재 반기 팀 목록(= loadCurrentClubStructure 가 세는 모집단과 같은 원천).
const currentHalfTeams = (org, mode) =>
  api(`/api/admin/team-parts/info?organization=${org}${mode === "test" ? "&mode=test" : ""}`);

void (async () => {
  COOKIE = await makeAdminCookie();
  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(1);
  const ACT_AS = markers?.[0]?.user_id ?? null;
  const PATHS = [
    { label: "operating", mode: "operating", actAs: null },
    { label: "test", mode: "test", actAs: null },
    ...(ACT_AS ? [{ label: "test+actAs", mode: "test", actAs: ACT_AS }] : []),
  ];
  console.log(`actAsTestUserId = ${ACT_AS ?? "(없음 — 해당 경로 생략)"}`);

  // 현재 반기 팀(org별 teamHalfId) — mode 별로 모집단이 다를 수 있어 각각 조회.
  const teamsByMode = new Map();
  for (const mode of ["operating", "test"]) {
    const list = [];
    for (const org of ORGS) {
      const r = await currentHalfTeams(org, mode);
      for (const t of r.json?.data?.teams ?? []) {
        list.push({ org, teamHalfId: t.teamHalfId, teamName: t.teamName });
      }
    }
    teamsByMode.set(mode, list);
    console.log(`현재 반기 팀(${mode}) = ${list.length}개`);
  }

  const focus = teamsByMode.get("test").find((t) => t.org === FOCUS_ORG && t.teamName === FOCUS_TEAM);
  if (!focus) { console.error("픽스처 팀 없음"); process.exit(1); }

  // ── C1 ────────────────────────────────────────────────────────────────
  console.log(`\n═══ C1. 팀 상세 상단 == [A] (${FOCUS_ORG}/${FOCUS_TEAM}) ═══`);
  const focusCounts = [];
  const detailKeys = [];
  for (const p of PATHS) {
    const d = await teamDetail(FOCUS_ORG, focus.teamHalfId, p.mode, p.actAs);
    const a = await weekSummary(FOCUS_ORG, focus.teamHalfId, p.mode, p.actAs);
    const top = d.json?.data?.operatedPartCount;
    const names = (a.json?.data?.operatedParts ?? []).map((x) => x.partName);
    focusCounts.push(top);
    detailKeys.push(J(Object.keys(d.json?.data ?? {})));
    console.log(`  [${p.label}] week=${a.json?.data?.week?.weekStartDate} 상단=${top} [A]=${J(names)}`);
    ck(`[${p.label}] HTTP 200`, d.status === 200 && a.status === 200, `${d.status}/${a.status}`);
    ck(`[${p.label}] 상단 == [A].length`, top === names.length, `${top} vs ${names.length}`);
    ck(`[${p.label}] = 4 (수정 전 3)`, top === 4, String(top));
    ck(`[${p.label}] override 전용 '테스트' 포함`, names.includes("테스트"), J(names));
    ck(`[${p.label}] 파트명 중복 없음`, new Set(names).size === names.length, J(names));
    ck(`[${p.label}] operatedPartCount 타입 number`, typeof top === "number");
    console.log(`      참고 카드 partNames = ${J(d.json?.data?.currentTeam?.partNames ?? null)} / 생성 파트 = ${J(d.json?.data?.generatedParts ?? null)}`);
  }
  ck("C1 파리티: 세 경로 동일 값", new Set(focusCounts).size === 1, J(focusCounts));
  ck("C1 DTO 키 동일", new Set(detailKeys).size === 1, detailKeys[0]);

  // 전 팀 스윕(test) — 상단 == [A]
  console.log("\n  현재 반기 전 팀 스윕(test):");
  let sweepDiff = 0;
  const sweepTeams = teamsByMode.get("test");
  for (const t of sweepTeams) {
    const d = await teamDetail(t.org, t.teamHalfId, "test", null);
    const a = await weekSummary(t.org, t.teamHalfId, "test", null);
    const top = d.json?.data?.operatedPartCount;
    const len = (a.json?.data?.operatedParts ?? []).length;
    if (top !== len) { sweepDiff++; console.log(`    ✗ [${t.org}] ${t.teamName} 상단=${top} [A]=${len}`); }
  }
  ck(`전 팀 스윕 불일치 0 (${sweepTeams.length}팀)`, sweepDiff === 0, `불일치 ${sweepDiff}`);

  // ── C2 ────────────────────────────────────────────────────────────────
  console.log("\n═══ C2. 클럽 요약 partCount == Σ <운용> 파트('일반' 제외) ═══");
  // 기대값 = mode 당 1회만 계산(팀별 [A] 목록에서 '일반' 제외).
  const expectByMode = new Map();
  for (const mode of ["operating", "test"]) {
    const byOrg = Object.fromEntries(ORGS.map((o) => [o, 0]));
    const detail = [];
    for (const t of teamsByMode.get(mode)) {
      const a = await weekSummary(t.org, t.teamHalfId, mode, null);
      const names = (a.json?.data?.operatedParts ?? []).map((x) => x.partName).filter((x) => x !== DEFAULT_PART);
      byOrg[t.org] += names.length;
      detail.push(`${t.org}/${t.teamName}:${names.length}`);
    }
    expectByMode.set(mode, byOrg);
    console.log(`  기대(${mode}) = ${J(byOrg)} 합계=${Object.values(byOrg).reduce((a, b) => a + b, 0)}`);
    console.log(`    내역: ${detail.join(", ")}`);
  }

  const totalsByPath = [];
  const summaryKeys = [];
  const rowKeys = [];
  for (const p of PATHS) {
    const s = await clubSummary(p.mode, p.actAs);
    ck(`[${p.label}] 클럽 요약 200`, s.status === 200, String(s.status));
    const data = s.json?.data;
    if (!data) continue;
    summaryKeys.push(J(Object.keys(data)));
    if (data.rows?.[0]) rowKeys.push(J(Object.keys(data.rows[0])));
    const expect = expectByMode.get(p.mode);
    const expectTotal = Object.values(expect).reduce((a, b) => a + b, 0);
    const rows = data.rows ?? [];
    const rowSum = rows.reduce((sum, r) => sum + (r.partCount ?? 0), 0);
    console.log(`  [${p.label}] rows=${J(rows.map((r) => `${r.clubId}:${r.partCount}`))} totals=${data.totals?.partCount} structureTotals=${data.structureTotals?.totalParts}`);
    for (const r of rows) {
      ck(`[${p.label}] ${r.clubId} partCount == Σ 팀별 운용 파트`, r.partCount === expect[r.clubId], `${r.partCount} vs ${expect[r.clubId]}`);
    }
    ck(`[${p.label}] 행 합계 == totals.partCount`, rowSum === data.totals?.partCount, `${rowSum} vs ${data.totals?.partCount}`);
    ck(`[${p.label}] totals.partCount == structureTotals.totalParts`, data.totals?.partCount === data.structureTotals?.totalParts, `${data.totals?.partCount} vs ${data.structureTotals?.totalParts}`);
    ck(`[${p.label}] 전체 합계 == 기대`, data.structureTotals?.totalParts === expectTotal, `${data.structureTotals?.totalParts} vs ${expectTotal}`);
    ck(`[${p.label}] partCount 전부 number`, rows.every((r) => typeof r.partCount === "number"));
    totalsByPath.push(data.structureTotals?.totalParts);
  }
  ck("C2 파리티: 세 경로 totalParts 동일", new Set(totalsByPath).size === 1, J(totalsByPath));
  ck("C2 DTO 키 동일(응답)", new Set(summaryKeys).size === 1, summaryKeys[0]);
  ck("C2 DTO 키 동일(행)", new Set(rowKeys).size === 1, rowKeys[0]);

  console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
  process.exit(fail > 0 ? 1 : 0);
})();
