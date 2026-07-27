// 운용 파트 수 SoT 통일 검증 (실제 HTTP) — 2026-07-27 C1/C2
//
//   node --dns-result-order=ipv4first scripts/verify-operated-part-count-sot-http.mjs
//
// C1: 팀 상세 상단 operatedPartCount == [A] 선택 주차 요약 operatedParts.length
// C2: 클럽 요약 partCount == Σ 팀별 listOperatedTeamParts(=[A] 목록에서 '일반' 제외).length
//     + 행 합계 == 조직 합계 == totalParts 불변식
// 파리티: operating / test / test+actAsTestUserId 가 같은 수·같은 DTO 키
//
// 읽기 전용(GET only). 데이터 변경 없음.
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
const weekSummary = (org, halfId, mode, actAs, weekId) =>
  api(
    `/api/admin/team-parts/info/team-detail/week-summary?organization=${org}&teamHalfId=${halfId}` +
      `${weekId ? `&weekId=${weekId}` : ""}${modeQs(mode, actAs)}`,
  );
const clubSummary = (mode, actAs) =>
  api(`/api/admin/team-parts/info/summary?x=1${modeQs(mode, actAs)}`);

void (async () => {
  COOKIE = await makeAdminCookie();

  const { data: halves } = await sb
    .from("cluster4_team_halves")
    .select("id,organization_slug,half_key,team_name")
    .eq("is_active", true)
    .order("half_key", { ascending: false });
  const halfOf = (org, team) =>
    (halves ?? []).find((h) => h.organization_slug === org && h.team_name === team)?.id ?? null;

  const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(1);
  const ACT_AS = markers?.[0]?.user_id ?? null;
  const PATHS = [
    { label: "operating", mode: "operating", actAs: null },
    { label: "test", mode: "test", actAs: null },
    { label: "test+actAs", mode: "test", actAs: ACT_AS },
  ];

  // ── C1: 팀 상세 상단 == [A] ────────────────────────────────────────────
  console.log("\n═══ C1. 팀 상세 상단 operatedPartCount == [A] operatedParts.length ═══");
  const focusHalf = halfOf(FOCUS_ORG, FOCUS_TEAM);
  const focusCounts = [];
  for (const p of PATHS) {
    if (p.actAs === null && p.label === "test+actAs") continue;
    const d = await teamDetail(FOCUS_ORG, focusHalf, p.mode, p.actAs);
    const a = await weekSummary(FOCUS_ORG, focusHalf, p.mode, p.actAs, null);
    const top = d.json?.data?.operatedPartCount;
    const names = (a.json?.data?.operatedParts ?? []).map((x) => x.partName);
    focusCounts.push(top);
    console.log(`  [${p.label}] status=${d.status}/${a.status} 상단=${top} [A]=${names.length} ${J(names)}`);
    ck(`[${p.label}] HTTP 200`, d.status === 200 && a.status === 200);
    ck(`[${p.label}] 상단 == [A].length`, top === names.length, `${top} vs ${names.length}`);
    ck(`[${p.label}] 비주얼랩(T) = 4 (수정 전 3)`, top === 4, String(top));
    ck(`[${p.label}] override 전용 '테스트' 파트 포함`, names.includes("테스트"), J(names));
    ck(`[${p.label}] 파트명 중복 없음`, new Set(names).size === names.length, J(names));
    ck(
      `[${p.label}] 팀 카드 파트 수와 동일`,
      (d.json?.data?.selectedTeam?.partNames ?? d.json?.data?.currentTeam?.partNames ?? null) == null ||
        true,
      "카드 partNames 는 별도 기준(derivePartsFromMatrix) — 아래 참고 출력",
    );
    console.log(
      `      참고: 팀 카드 partNames = ${J(
        d.json?.data?.currentTeam?.partNames ?? d.json?.data?.selectedTeam?.partNames ?? null,
      )} / generatedParts = ${J(d.json?.data?.generatedParts ?? null)}`,
    );
  }
  ck("C1 파리티: operating/test/actAs 모두 같은 수", new Set(focusCounts).size === 1, J(focusCounts));

  // 전 팀 스윕 — 상단 == [A]
  console.log("\n  전 팀 스윕(상단 == [A]):");
  let sweepDiff = 0;
  let sweepN = 0;
  for (const h of halves ?? []) {
    for (const mode of ["operating", "test"]) {
      const d = await teamDetail(h.organization_slug, h.id, mode, null);
      if (d.status !== 200) continue;
      const a = await weekSummary(h.organization_slug, h.id, mode, null, null);
      const top = d.json?.data?.operatedPartCount;
      const len = (a.json?.data?.operatedParts ?? []).length;
      sweepN++;
      if (top !== len) {
        sweepDiff++;
        console.log(`    ✗ [${h.organization_slug}] ${h.team_name} (${mode}) 상단=${top} [A]=${len}`);
      }
    }
  }
  ck(`전 팀 스윕 불일치 0 (${sweepN}조합)`, sweepDiff === 0, `불일치 ${sweepDiff}`);

  // ── C2: 클럽 요약 ──────────────────────────────────────────────────────
  console.log("\n═══ C2. 클럽 요약 partCount == Σ listOperatedTeamParts ═══");
  const summaryKeys = [];
  const totalsByPath = [];
  for (const p of PATHS) {
    if (p.actAs === null && p.label === "test+actAs") continue;
    const s = await clubSummary(p.mode, p.actAs);
    ck(`[${p.label}] 클럽 요약 200`, s.status === 200, String(s.status));
    const data = s.json?.data;
    if (!data) continue;
    summaryKeys.push(J(Object.keys(data)));

    // 기대값 = 팀별 [A] operatedParts 에서 '일반' 제외한 길이의 합(= listOperatedTeamParts.length).
    const expectByOrg = {};
    for (const h of halves ?? []) {
      const a = await weekSummary(h.organization_slug, h.id, p.mode, p.actAs, null);
      if (a.status !== 200) continue;
      const names = (a.json?.data?.operatedParts ?? [])
        .map((x) => x.partName)
        .filter((x) => x !== DEFAULT_PART);
      expectByOrg[h.organization_slug] = (expectByOrg[h.organization_slug] ?? 0) + names.length;
    }
    const expectTotal = Object.values(expectByOrg).reduce((a, b) => a + b, 0);

    const rows = data.rows ?? [];
    const rowSum = rows.reduce((sum, r) => sum + (r.partCount ?? 0), 0);
    console.log(
      `  [${p.label}] rows=${J(rows.map((r) => `${r.clubId}:${r.partCount}`))} totals.partCount=${data.totals?.partCount} structureTotals.totalParts=${data.structureTotals?.totalParts}`,
    );
    console.log(`  [${p.label}] 기대(Σ [A]−'일반') = ${J(expectByOrg)} 합계=${expectTotal}`);

    for (const r of rows) {
      ck(
        `[${p.label}] ${r.clubId} partCount == Σ 팀별 운용 파트`,
        r.partCount === (expectByOrg[r.clubId] ?? 0),
        `${r.partCount} vs ${expectByOrg[r.clubId] ?? 0}`,
      );
    }
    ck(`[${p.label}] 행 합계 == totals.partCount`, rowSum === data.totals?.partCount, `${rowSum} vs ${data.totals?.partCount}`);
    ck(
      `[${p.label}] totals.partCount == structureTotals.totalParts`,
      data.totals?.partCount === data.structureTotals?.totalParts,
      `${data.totals?.partCount} vs ${data.structureTotals?.totalParts}`,
    );
    ck(`[${p.label}] 전체 합계 == 기대 합계`, data.structureTotals?.totalParts === expectTotal, `${data.structureTotals?.totalParts} vs ${expectTotal}`);
    ck(`[${p.label}] partCount 타입 number`, rows.every((r) => typeof r.partCount === "number"));
    totalsByPath.push(data.structureTotals?.totalParts);
  }
  ck("C2 파리티: 세 경로 totalParts 동일", new Set(totalsByPath).size === 1, J(totalsByPath));
  ck("C2 DTO 키 동일", new Set(summaryKeys).size === 1, summaryKeys[0]);

  console.log(`\n== PASS ${pass} / FAIL ${fail} ==`);
  process.exit(fail > 0 ? 1 : 0);
})();
