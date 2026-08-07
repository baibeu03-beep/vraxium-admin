/**
 * 검증 — 팀/팀장의 시간축(effective-from) 정합성 회귀 방지.
 *
 *   배경: cluster4_team_halves 는 반기(half, ~26주) 단위 카탈로그라 주차 단위 effective-from 이
 *   없었다. 반기 중간에 새 팀을 만들면 그 반기의 지나간 주차를 조회해도 팀·팀장이 이미 존재하는
 *   것처럼 보였다(2026-08-07 실측·수정). 수정은 새 컬럼/새 테이블 없이 cluster4_team_week_position_
 *   overrides(팀장 배정 이력, position_code='operating_team_leader')를 팀의 시간축으로 재사용한다
 *   — registerTeamHalf/updateTeamHalf 가 팀 생성·팀장 교체마다 이미 이 표에 정확한 주차로 행을 쓴다.
 *
 *   실행: npx tsx --env-file=.env.local scripts/verify-team-time-scoping.mjs
 *   사전조건: dev 서버(:3000) 기동 + phalanx QA 팀/크루 시드 존재. mutate 대상은 신규 생성한 임시
 *   QA 팀 1개뿐이며 종료 시 하드 삭제 + 관련 override 삭제 + 크루 프로필 원복까지 수행한다.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

const ORG = "phalanx";
let fail = 0;
let pass = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

async function cookieHeader() {
  const { data: admins } = await sb
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── ①  순수 함수 단위 검증(DB 불필요) ─────────────────────────────────────────
async function verifyPureFunctions() {
  console.log("\n[1] 순수 함수 — resolveTeamExistenceFromWeek / resolveTeamLeaderAtWeek");
  const { resolveTeamExistenceFromWeek, resolveTeamLeaderAtWeek } = await import(
    "../lib/teamWeekPositionOverride.ts"
  );

  ck("이력 없음 → existsFrom=null(레거시, 제한 없음)", resolveTeamExistenceFromWeek(undefined) === null);
  ck(
    "이력 없음 → 리더는 폴백값(카탈로그 현재값)",
    resolveTeamLeaderAtWeek(undefined, "2026-07-27", "FALLBACK") === "FALLBACK",
  );

  const history = [
    { userId: "A", weekStartDate: "2026-08-03" },
    { userId: "B", weekStartDate: "2026-08-10" },
  ];
  ck("existsFrom = 이력 중 최초 주차", resolveTeamExistenceFromWeek(history) === "2026-08-03");
  ck("생성 이전 주차 리더 = null(팀 미존재 구간)", resolveTeamLeaderAtWeek(history, "2026-07-27", "FALLBACK") === null);
  ck("생성 주차 리더 = A", resolveTeamLeaderAtWeek(history, "2026-08-03", "FALLBACK") === "A");
  ck("교체 전 주차(같은 구간) 리더 유지 = A", resolveTeamLeaderAtWeek(history, "2026-08-09", "FALLBACK") === "A");
  ck("교체 주차 리더 = B", resolveTeamLeaderAtWeek(history, "2026-08-10", "FALLBACK") === "B");
  ck("교체 이후 주차도 B carry-forward", resolveTeamLeaderAtWeek(history, "2026-09-01", "FALLBACK") === "B");
}

// ── ②  실제 팀 HTTP e2e — 신규 생성 → 시나리오 A/B/D 동시 검증 ────────────────
async function verifyHttpScenarios() {
  console.log("\n[2] HTTP e2e — crew-week-results teamExists/leader 시간축");

  const { data: weeks } = await sb
    .from("weeks")
    .select("id,start_date")
    .gte("start_date", "2026-06-20")
    .lte("start_date", "2026-08-20")
    .order("start_date", { ascending: true });
  // 현재 주차(팀 생성 시점) 자동 판별 — resolveCurrentWeekStartDate 와 동일 규칙(오늘 포함 구간).
  const { data: curWeekRows } = await sb
    .from("weeks")
    .select("id,start_date,end_date")
    .lte("start_date", new Date().toISOString().slice(0, 10))
    .order("start_date", { ascending: false })
    .limit(1);
  const currentWeek = curWeekRows?.[0];
  if (!currentWeek) {
    console.log("  ⚠ 현재 주차를 찾지 못해 HTTP 시나리오를 건너뜁니다(SKIP).");
    return;
  }
  const currentIdx = weeks.findIndex((w) => w.id === currentWeek.id);
  const priorWeek = weeks[currentIdx - 1]; // 생성 이전 주차(teamExists=false 기대)
  const nextWeek = weeks[currentIdx + 1]; // 교체 시뮬레이션 주차(teamExists=true, leader=B 기대)
  if (!priorWeek || !nextWeek) {
    console.log("  ⚠ 앞/뒤 주차를 찾지 못해 HTTP 시나리오를 건너뜁니다(SKIP).");
    return;
  }

  // QA 스코프 크루 2명(하드코딩 아님 — is_qa_test 팀 소속 crew 중 동적 조회).
  const { data: qaTeams } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name,leader_user_id")
    .eq("organization_slug", ORG)
    .eq("is_qa_test", true)
    .eq("is_active", true)
    .not("leader_user_id", "is", null)
    .limit(20);
  const leaderIds = Array.from(new Set((qaTeams ?? []).map((t) => t.leader_user_id).filter(Boolean)));
  // registerTeamHalf 는 crew_code 로 팀장을 재해석하므로 crew_code 보유자만 후보로 쓴다.
  const { data: candidateProfs } = leaderIds.length
    ? await sb
        .from("user_profiles")
        .select("user_id,crew_code,role,current_team_name,current_part_name")
        .in("user_id", leaderIds)
        .not("crew_code", "is", null)
    : { data: [] };
  if ((candidateProfs ?? []).length < 2) {
    console.log("  ⚠ crew_code 보유 QA 팀장이 2명 미만이라 HTTP 시나리오를 건너뜁니다(SKIP).");
    return;
  }
  const [aProf, bProf] = candidateProfs;
  const A = aProf.user_id;
  const B = bProf.user_id;

  const { data: halfRow } = await sb
    .from("weeks")
    .select("season_key")
    .eq("id", currentWeek.id)
    .maybeSingle();
  const HALF = halfRow?.season_key?.endsWith("summer") || halfRow?.season_key?.endsWith("autumn")
    ? `${halfRow.season_key.slice(0, 4)}-H2`
    : `${halfRow?.season_key?.slice(0, 4) ?? "2026"}-H1`;

  const TEAM_NAME = `QA${Date.now().toString(36).slice(-4)}(T)`;
  const cookie = await cookieHeader();
  let teamHalfId = null;
  try {
    const createRes = await fetch(`${BASE}/api/admin/team-parts/info?mode=test`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        organization: ORG,
        halfKey: HALF,
        teamName: TEAM_NAME,
        description: "시간축 회귀 검증 임시 팀",
        leaderCrewCode: aProf.crew_code,
      }),
    }).then((r) => r.json());
    if (!createRes.success) throw new Error("팀 생성 실패: " + createRes.error);
    teamHalfId = createRes.data.teams.find((t) => t.teamName === TEAM_NAME)?.teamHalfId ?? null;
    ck("팀 생성 성공(현재 주차 기준)", !!teamHalfId, TEAM_NAME);

    // 팀장 교체를 다음 주차로 합성(실제 시간 경과 없이 시나리오 D 재현) — DB 직결 삽입.
    const { error: insErr } = await sb.from("cluster4_team_week_position_overrides").upsert(
      {
        user_id: B,
        organization: ORG,
        week_id: nextWeek.id,
        week_start_date: nextWeek.start_date,
        raw_team: TEAM_NAME,
        raw_part: null,
        position_code: "operating_team_leader",
        created_by: "verify:team-time-scoping",
        updated_by: "verify:team-time-scoping",
      },
      { onConflict: "user_id,week_start_date,organization,raw_team" },
    );
    if (insErr) throw new Error("합성 교체 override 삽입 실패: " + insErr.message);

    const fetchBase = async (weekId) =>
      fetch(`${BASE}/api/admin/team-parts/info/crew-week-results/${ORG}/${weekId}?action=base&mode=test`, {
        headers: { cookie },
      }).then((r) => r.json());

    const before = await fetchBase(priorWeek.id);
    const rowBefore = (before.data?.baseTeamRows ?? []).find((t) => t.teamName === TEAM_NAME);
    ck(`생성 이전 주차(${priorWeek.start_date}) → 팀 없음`, !rowBefore, JSON.stringify(rowBefore ?? null));

    const atCreate = await fetchBase(currentWeek.id);
    const rowAtCreate = (atCreate.data?.baseTeamRows ?? []).find((t) => t.teamName === TEAM_NAME);
    ck(
      `생성 주차(${currentWeek.start_date}) → 팀 존재·리더=A`,
      !!rowAtCreate && rowAtCreate.leader?.userId === A,
      JSON.stringify(rowAtCreate?.leader ?? null),
    );

    const afterSwap = await fetchBase(nextWeek.id);
    const rowAfterSwap = (afterSwap.data?.baseTeamRows ?? []).find((t) => t.teamName === TEAM_NAME);
    ck(
      `교체 주차(${nextWeek.start_date}) → 팀 존재·리더=B`,
      !!rowAfterSwap && rowAfterSwap.leader?.userId === B,
      JSON.stringify(rowAfterSwap?.leader ?? null),
    );
  } catch (e) {
    ck("HTTP 시나리오 실행", false, e instanceof Error ? e.message : String(e));
  } finally {
    if (teamHalfId) {
      await sb.from("cluster4_team_halves").delete().eq("id", teamHalfId);
      await sb.from("cluster4_team_parts").delete().eq("team_half_id", teamHalfId);
    }
    await sb.from("cluster4_team_week_position_overrides").delete().eq("organization", ORG).eq("raw_team", TEAM_NAME);
    if (aProf) {
      await sb
        .from("user_profiles")
        .update({ role: aProf.role, current_team_name: aProf.current_team_name, current_part_name: aProf.current_part_name })
        .eq("user_id", A);
    }
    if (bProf) {
      await sb
        .from("user_profiles")
        .update({ role: bProf.role, current_team_name: bProf.current_team_name, current_part_name: bProf.current_part_name })
        .eq("user_id", B);
    }
    console.log("  ↺ 원복 완료(임시 팀 삭제·override 삭제·A/B 프로필 복원)");
  }
}

// ── ③  레거시 팀 무회귀 — 팀장 배정 이력이 없는 기존 팀은 게이트가 걸리지 않아야 한다 ──
async function verifyLegacyNoRegression() {
  console.log("\n[3] 레거시 팀 무회귀 — 이력 없는 팀은 과거 주차에서도 그대로 노출되어야 한다");
  const { data: legacyTeam } = await sb
    .from("cluster4_team_halves")
    .select("team_name")
    .eq("organization_slug", ORG)
    .in("half_key", ["2024-H1", "2024-H2", "2025-H1"])
    .limit(1)
    .maybeSingle();
  if (!legacyTeam) {
    console.log("  ⚠ 레거시 반기 팀을 찾지 못해 건너뜁니다(SKIP).");
    return;
  }
  const { loadTeamLeaderAssignmentHistory, resolveTeamExistenceFromWeek } = await import(
    "../lib/teamWeekPositionOverride.ts"
  );
  const history = await loadTeamLeaderAssignmentHistory(ORG, [legacyTeam.team_name]);
  const existsFrom = resolveTeamExistenceFromWeek(history.get(legacyTeam.team_name));
  ck(
    `레거시 팀(${legacyTeam.team_name})은 팀장 배정 이력이 없어 게이트 없음`,
    existsFrom === null,
    `existsFrom=${existsFrom}`,
  );
}

async function main() {
  await verifyPureFunctions();
  await verifyHttpScenarios();
  await verifyLegacyNoRegression();
  console.log(`\n=== 결과: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error("치명적 오류:", e);
  process.exit(1);
});
