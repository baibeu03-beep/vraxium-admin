/**
 * verify-experience-overall-review-gate.ts
 * 실무 경험 [팀 총괄] — [개설 검수] 사전조건: "모든 대상 파트 [개설 신청] 완료" 게이트 검증.
 *
 *   판정 SoT = resolveOverallApplicationReadiness(board.parts) (프론트/백엔드 공용).
 *   - board.application (getTeamOverallBoard DTO 필드) == loadOverallApplicationReadiness (서버 가드) 동일 판정
 *   - saveTeamOverallReview: 미신청 파트 존재 시 409 throw / 전 파트 신청 시 통과
 *   - 실제 HTTP POST(review): 미신청→409, 전 신청→201 (dev 서버 :3000 필요, best-effort)
 *   - operating(일반) vs test(테스트) 동일 코드경로/DTO 필드
 *   - org 스코프: 팀 판정이 org+team 로 한정
 *
 *   실행: npx tsx --env-file=.env.local scripts/verify-experience-overall-review-gate.ts
 *   ⚠ 검수는 임시저장(고객 미반영)이며, 스크립트가 seed 한 part_submissions + overall 헤더를 모두 원복한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  getTeamOverallBoard,
  loadOverallApplicationReadiness,
  saveTeamOverallReview,
} from "@/lib/adminExperienceTeamOverall";
import { OVERALL_APPLICATION_INCOMPLETE_MESSAGE } from "@/lib/experienceTeamOverallTypes";
import type { ScopeMode } from "@/lib/userScope";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const TEST_ORG = "oranke";
const TEST_TEAM_NAME = "과일(T)"; // test 모드 팀

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function latestWeekId(): Promise<string> {
  const { data } = await sb
    .from("weeks")
    .select("id")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error("weeks 없음");
  return id;
}

async function teamIdByName(org: string, name: string): Promise<string | null> {
  const { data } = await sb
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", org)
    .eq("team_name", name)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function cleanOverall(org: string, weekId: string, teamId: string) {
  await sb
    .from("cluster4_experience_team_overall")
    .delete()
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
}

async function cleanPartSubmissions(org: string, weekId: string, teamId: string) {
  await sb
    .from("cluster4_experience_part_submissions")
    .delete()
    .eq("organization_slug", org)
    .eq("week_id", weekId)
    .eq("team_id", teamId);
}

// 파트 [개설 신청] seed = 헤더 1행(part_name) upsert. 셀은 판정과 무관(submittedParts=part_name set).
async function seedApply(org: string, weekId: string, teamId: string, partName: string) {
  await sb.from("cluster4_experience_part_submissions").upsert(
    {
      organization_slug: org,
      week_id: weekId,
      team_id: teamId,
      part_name: partName,
      submitted_by: null,
      submitted_at: new Date().toISOString(),
    },
    { onConflict: "organization_slug,week_id,team_id,part_name" },
  );
}

async function adminCookieHeader(): Promise<string | null> {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE);
    const browser = createClient(SUPABASE_URL, ANON);
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: ADMIN_EMAIL,
    });
    if (linkErr) throw linkErr;
    const otp = linkData.properties?.email_otp;
    if (!otp) throw new Error("email_otp 없음");
    const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
      email: ADMIN_EMAIL,
      token: otp,
      type: "magiclink",
    });
    if (vErr) throw vErr;
    const captured: Array<{ name: string; value: string }> = [];
    const server = createServerClient(SUPABASE_URL, ANON, {
      cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
    });
    await server.auth.setSession({
      access_token: verifyData.session!.access_token,
      refresh_token: verifyData.session!.refresh_token,
    });
    return captured.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return null;
  }
}

async function httpGet(cookie: string, org: string, weekId: string, teamId: string, teamName: string, mode?: ScopeMode) {
  const qs = new URLSearchParams({ organization: org, week_id: weekId, team_id: teamId, team_name: teamName });
  if (mode === "test") qs.set("mode", "test");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall?${qs}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function httpReview(cookie: string, org: string, weekId: string, teamId: string, teamName: string, mode: ScopeMode) {
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      action: "review",
      organization: org,
      week_id: weekId,
      team_id: teamId,
      team_name: teamName,
      leaderCells: [],
      outputs: [],
      mode,
    }),
  });
  return { status: res.status, json: await res.json() };
}

async function runModeDirect(label: string, mode: ScopeMode, org: string, teamId: string, teamName: string, weekId: string) {
  console.log(`\n=== [${label}] mode=${mode} org=${org} team=${teamName} ===`);
  await cleanOverall(org, weekId, teamId);
  await cleanPartSubmissions(org, weekId, teamId);

  const board0 = await getTeamOverallBoard(org, weekId, teamId, teamName, mode);
  const partNames = board0.parts.map((p) => p.partName);
  ck(`[${label}] 대상 파트 존재`, partNames.length >= 1, `parts=${JSON.stringify(partNames)}`);
  if (partNames.length === 0) return;

  // 프론트(board.application) == 서버 가드(loadOverallApplicationReadiness) 동일 판정.
  const gate0 = await loadOverallApplicationReadiness(org, weekId, teamId, teamName, mode);
  ck(
    `[${label}] board.application == loadOverallApplicationReadiness (프론트==백엔드 판정)`,
    JSON.stringify(board0.application) === JSON.stringify(gate0),
    JSON.stringify(board0.application),
  );

  // ── 상태 1: 미신청 파트 존재 ──
  ck(
    `[${label}] (1)미신청: allPartsApplied=false`,
    board0.application.allPartsApplied === false,
    `total=${board0.application.totalPartCount} applied=${board0.application.appliedPartCount} unapplied=${JSON.stringify(board0.application.unappliedParts)}`,
  );
  ck(
    `[${label}] (1)미신청: unappliedParts==전체(신청 0)`,
    board0.application.unappliedParts.length === partNames.length && board0.application.appliedPartCount === 0,
  );
  let threw = false, msg = "", status = 0;
  try {
    await saveTeamOverallReview({ organization: org, weekId, teamId, teamName, leaderCells: [], outputs: [], adminId: null, mode });
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
    status = (e as { status?: number }).status ?? 0;
  }
  ck(`[${label}] (1)미신청: saveTeamOverallReview 차단(409)`, threw && status === 409, `status=${status} msg=${JSON.stringify(msg.slice(0, 70))}`);
  ck(`[${label}] (1)미신청: 문구=공용 메시지+미신청 목록`, msg.startsWith(OVERALL_APPLICATION_INCOMPLETE_MESSAGE) && msg.includes("미신청 파트:"));
  const { data: afterBlock } = await sb
    .from("cluster4_experience_team_overall")
    .select("id").eq("organization_slug", org).eq("week_id", weekId).eq("team_id", teamId);
  ck(`[${label}] (1)미신청: 차단 후 헤더 미생성(write 없음)`, (afterBlock ?? []).length === 0);

  // ── 경계: 일부만 신청 ──
  if (partNames.length >= 2) {
    await seedApply(org, weekId, teamId, partNames[0]);
    const bp = await getTeamOverallBoard(org, weekId, teamId, teamName, mode);
    ck(
      `[${label}] (경계)일부 신청: allPartsApplied=false, applied=1`,
      bp.application.allPartsApplied === false && bp.application.appliedPartCount === 1 && bp.application.unappliedParts.length === partNames.length - 1,
      `unapplied=${JSON.stringify(bp.application.unappliedParts)}`,
    );
  }

  // ── 상태 2: 모든 파트 신청 완료 ──
  for (const p of partNames) await seedApply(org, weekId, teamId, p);
  const board2 = await getTeamOverallBoard(org, weekId, teamId, teamName, mode);
  ck(
    `[${label}] (2)전 파트 신청: allPartsApplied=true, unapplied=[]`,
    board2.application.allPartsApplied === true && board2.application.unappliedParts.length === 0 && board2.application.appliedPartCount === board2.application.totalPartCount,
    `applied=${board2.application.appliedPartCount}/${board2.application.totalPartCount}`,
  );
  const rev = await saveTeamOverallReview({ organization: org, weekId, teamId, teamName, leaderCells: [], outputs: [], adminId: null, mode });
  ck(`[${label}] (2)전 파트 신청: saveTeamOverallReview 통과(reviewed)`, rev.status === "reviewed");

  // ── 상태 3: 검수 완료(전이 정상) ──
  const board3 = await getTeamOverallBoard(org, weekId, teamId, teamName, mode);
  ck(`[${label}] (3)검수 완료: status=reviewed`, board3.status === "reviewed");

  await cleanOverall(org, weekId, teamId);
  await cleanPartSubmissions(org, weekId, teamId);
}

// operating 실파트 보유 (org, team) 자동 선택 — 전 org·전 팀 스캔(mode=operating 로 parts≥1).
//   test 팀(과일(T))과 겹치지 않도록 가능하면 다른 팀을 우선 선택.
async function pickOperatingTeam(weekId: string): Promise<{ org: string; id: string; name: string } | null> {
  const { data } = await sb.from("cluster4_teams").select("id,team_name,organization_slug");
  const rows = (data ?? []) as Array<{ id: string; team_name: string; organization_slug: string }>;
  const matches: Array<{ org: string; id: string; name: string }> = [];
  for (const t of rows) {
    const b = await getTeamOverallBoard(t.organization_slug, weekId, t.id, t.team_name, "operating");
    if (b.parts.length >= 1) matches.push({ org: t.organization_slug, id: t.id, name: t.team_name });
  }
  // test 팀과 다른 팀 우선(모드별 독립 검증), 없으면 첫 매치.
  return matches.find((m) => !(m.org === TEST_ORG && m.name === TEST_TEAM_NAME)) ?? matches[0] ?? null;
}

async function main() {
  const weekId = await latestWeekId();
  console.log(`대상 주차(latest) = ${weekId}`);

  // ── 일반 모드(operating) — 실파트 보유 팀 자동 선택 ──
  const opTeam = await pickOperatingTeam(weekId);
  if (opTeam) {
    console.log(`operating 팀 자동 선택 = ${opTeam.org}/${opTeam.name} (${opTeam.id})`);
    await runModeDirect("operating", "operating", opTeam.org, opTeam.id, opTeam.name, weekId);
  } else {
    ck("[operating] 실파트 보유 팀 탐색", false, "전 org operating 팀 중 parts≥1 없음 — operating 직접판정 스킵");
  }

  // ── 테스트 모드(test) ──
  const testTeamId = await teamIdByName(TEST_ORG, TEST_TEAM_NAME);
  if (testTeamId) {
    await runModeDirect("test", "test", TEST_ORG, testTeamId, TEST_TEAM_NAME, weekId);
  } else {
    ck("[test] (T)팀 team_id 조회", false, `${TEST_ORG}/${TEST_TEAM_NAME} 없음 — test 직접판정 스킵`);
  }

  // ── org 스코프: 팀 판정이 org+team 로 한정(타 org 슬러그로 같은 team_id → 대상 파트 0) ──
  if (opTeam) {
    const b = await getTeamOverallBoard(opTeam.org, weekId, opTeam.id, opTeam.name, "operating");
    const otherOrg = opTeam.org === "oranke" ? "phalanx" : "oranke";
    const other = await getTeamOverallBoard(otherOrg, weekId, opTeam.id, opTeam.name, "operating");
    ck(
      `[org] org+team 스코프 — 타 org(${otherOrg})에서 동일 team_id 대상 파트 0`,
      b.parts.length >= 1 && other.parts.length === 0 && other.application.totalPartCount === 0 && other.application.allPartsApplied === false,
      `${opTeam.org} parts=${b.parts.length} / ${otherOrg} parts=${other.parts.length}`,
    );
  }

  // ── 실제 HTTP(dev :3000) — best-effort. operating+test 두 모드 모두 라우트로 왕복 ──
  console.log("\n=== [HTTP] 실제 라우트(:3000) ===");
  const cookie = await adminCookieHeader();
  const legs: Array<{ label: string; mode: ScopeMode; org: string; teamId: string; teamName: string }> = [];
  if (opTeam) legs.push({ label: "operating", mode: "operating", org: opTeam.org, teamId: opTeam.id, teamName: opTeam.name });
  if (testTeamId) legs.push({ label: "test", mode: "test", org: TEST_ORG, teamId: testTeamId, teamName: TEST_TEAM_NAME });

  let serverUp = false;
  if (cookie && legs.length > 0) {
    const probe = await httpGet(cookie, legs[0].org, weekId, legs[0].teamId, legs[0].teamName, legs[0].mode).catch(() => null);
    serverUp = probe?.status === 200;
  }
  if (!cookie) {
    console.log("  (admin 쿠키 발급 실패 — HTTP 스킵)");
  } else if (!serverUp) {
    console.log("  (dev 서버 미기동 — HTTP 스킵; `npm run dev` 후 재실행)");
  } else {
    for (const leg of legs) {
      await cleanOverall(leg.org, weekId, leg.teamId);
      await cleanPartSubmissions(leg.org, weekId, leg.teamId);
      const g0 = await httpGet(cookie, leg.org, weekId, leg.teamId, leg.teamName, leg.mode);
      const app0 = g0.json?.data?.application;
      const partNames: string[] = (g0.json?.data?.parts ?? []).map((p: { partName: string }) => p.partName);
      ck(`[HTTP:${leg.label}] GET 200 + application 필드 존재`, g0.status === 200 && !!app0, `status=${g0.status}`);
      if (partNames.length === 0) {
        ck(`[HTTP:${leg.label}] 대상 파트 존재`, false, "0 파트 — HTTP 검수 스킵");
        continue;
      }
      ck(`[HTTP:${leg.label}] (1)미신청 GET: allPartsApplied=false`, app0.allPartsApplied === false, JSON.stringify(app0));
      const r1 = await httpReview(cookie, leg.org, weekId, leg.teamId, leg.teamName, leg.mode);
      ck(
        `[HTTP:${leg.label}] (1)미신청 POST review → 409 + 공용 문구`,
        r1.status === 409 && typeof r1.json?.error === "string" && r1.json.error.startsWith(OVERALL_APPLICATION_INCOMPLETE_MESSAGE),
        `status=${r1.status} err=${JSON.stringify((r1.json?.error ?? "").slice(0, 50))}`,
      );
      for (const p of partNames) await seedApply(leg.org, weekId, leg.teamId, p);
      const g2 = await httpGet(cookie, leg.org, weekId, leg.teamId, leg.teamName, leg.mode);
      ck(`[HTTP:${leg.label}] (2)전 신청 GET: allPartsApplied=true`, g2.json?.data?.application?.allPartsApplied === true);
      const r2 = await httpReview(cookie, leg.org, weekId, leg.teamId, leg.teamName, leg.mode);
      ck(`[HTTP:${leg.label}] (2)전 신청 POST review → 201`, r2.status === 201 && r2.json?.success, `status=${r2.status} err=${r2.json?.error ?? ""}`);
      const g3 = await httpGet(cookie, leg.org, weekId, leg.teamId, leg.teamName, leg.mode);
      ck(`[HTTP:${leg.label}] (3)검수 완료 GET: status=reviewed`, g3.json?.data?.status === "reviewed");
      await cleanOverall(leg.org, weekId, leg.teamId);
      await cleanPartSubmissions(leg.org, weekId, leg.teamId);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
