// 검증: 실무 경험 테스트 팀/파트 스코프 안전장치(direct).
//   npx tsx --env-file=.env.local scripts/verify-experience-test-scope.ts
//
// read-only + guard-only. 성공 경로 write(savePartSubmission/openTeamOverall) 는 호출하지 않는다
// (프로덕션 데이터 오염 방지). 거부 경로(throw)만 호출해 가드 동작을 확인한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  assertCrewIdsInScope,
  isTestTeam,
  resolveTeamName,
} from "@/lib/cluster4ExperienceTestScope";
import {
  listPartCrews,
  listTeamParts,
  savePartSubmission,
} from "@/lib/adminExperiencePartInput";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
}
async function expectThrow(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(label, false, "throw 기대했으나 통과함");
  } catch (e) {
    check(label, true, `차단됨: ${(e as Error).message.slice(0, 70)}…`);
  }
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  console.log("test_user_markers:", testIds.size);

  // ── 1) 테스트 팀 목록 = test_user_markers 만 ──
  const testTeams: Array<[string, string]> = [
    ["oranke", "과일(T)"],
    ["encre", "사운드(T)"],
    ["phalanx", "전략(T)"],
  ];
  let sampleTestUserId: string | null = null;
  for (const [org, team] of testTeams) {
    const parts = await listTeamParts(org, team);
    let crewTotal = 0;
    let realInList = 0;
    for (const part of parts) {
      const crews = await listPartCrews(org, team, part);
      crewTotal += crews.length;
      for (const c of crews) {
        if (!testIds.has(c.userId)) realInList++;
        if (!sampleTestUserId && testIds.has(c.userId)) sampleTestUserId = c.userId;
      }
    }
    check(
      `[테스트팀] ${org}/${team} 목록 = 테스트 계정만`,
      crewTotal > 0 && realInList === 0,
      `parts=${parts.length} crews=${crewTotal} real혼입=${realInList}`,
    );
    check(`[스코프] isTestTeam(${org}, ${team})`, isTestTeam(org, team));
  }

  // ── 2) 운영 팀 목록 = test_user_markers 제외 ──
  // 테스트 팀이 아닌 활성 팀을 org 별로 하나 골라 검사.
  for (const org of ["oranke", "encre", "phalanx"]) {
    const { data: teamRows } = await supabaseAdmin
      .from("cluster4_teams")
      .select("team_name")
      .eq("organization_slug", org)
      .eq("is_active", true)
      .order("team_name");
    const opTeam = ((teamRows ?? []) as Array<{ team_name: string }>)
      .map((r) => r.team_name)
      .find((name) => !isTestTeam(org, name));
    if (!opTeam) {
      check(`[운영팀] ${org} 운영 팀 존재`, false, "활성 운영 팀 없음");
      continue;
    }
    const parts = await listTeamParts(org, opTeam);
    let testInList = 0;
    let crewTotal = 0;
    for (const part of parts) {
      const crews = await listPartCrews(org, opTeam, part);
      crewTotal += crews.length;
      for (const c of crews) if (testIds.has(c.userId)) testInList++;
    }
    check(
      `[운영팀] ${org}/${opTeam} 목록 = 테스트 계정 제외`,
      testInList === 0,
      `parts=${parts.length} crews=${crewTotal} test혼입=${testInList}`,
    );
  }

  // ── 3) assertCrewIdsInScope 진리표 ──
  // 실사용자 1명 확보(테스트 마커 비등재 + 활성 프로필).
  const { data: realProf } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", "oranke")
    .limit(200);
  const realUserId =
    ((realProf ?? []) as Array<{ user_id: string }>)
      .map((r) => r.user_id)
      .find((id) => !testIds.has(id)) ?? null;
  console.log("sampleTestUserId:", sampleTestUserId, "realUserId:", realUserId);

  if (sampleTestUserId) {
    await assertCrewIdsInScope("oranke", "과일(T)", [sampleTestUserId]);
    check("[가드] 테스트팀 + 테스트계정 = 통과", true);
  }
  if (realUserId) {
    await expectThrow("[가드] 테스트팀 + 실사용자 = 차단", () =>
      assertCrewIdsInScope("oranke", "과일(T)", [realUserId]),
    );
    await assertCrewIdsInScope("oranke", "운영아무팀이라치고", [realUserId]).catch(() => {});
  }
  if (sampleTestUserId && realUserId) {
    await expectThrow("[가드] 테스트팀 + (테스트+실사용자 혼합) = 차단", () =>
      assertCrewIdsInScope("oranke", "과일(T)", [sampleTestUserId!, realUserId]),
    );
  }

  // 운영 팀 + 테스트 계정 = 차단.
  {
    const { data: teamRows } = await supabaseAdmin
      .from("cluster4_teams")
      .select("team_name")
      .eq("organization_slug", "oranke")
      .eq("is_active", true)
      .order("team_name");
    const opTeam = ((teamRows ?? []) as Array<{ team_name: string }>)
      .map((r) => r.team_name)
      .find((name) => !isTestTeam("oranke", name));
    if (opTeam && sampleTestUserId) {
      await expectThrow(`[가드] 운영팀(${opTeam}) + 테스트계정 = 차단`, () =>
        assertCrewIdsInScope("oranke", opTeam, [sampleTestUserId!]),
      );
    }
  }

  // ── 4) savePartSubmission 거부 경로(실사용자 혼입 → write 전 중단) ──
  // 테스트 팀 teamId 해석 후, 실사용자 cell 1개로 저장 시도 → throw 기대(헤더 미생성).
  if (realUserId) {
    const { data: tRow } = await supabaseAdmin
      .from("cluster4_teams")
      .select("id")
      .eq("organization_slug", "oranke")
      .eq("team_name", "과일(T)")
      .maybeSingle();
    const teamId = (tRow as { id: string } | null)?.id ?? null;
    const resolved = teamId ? await resolveTeamName(teamId) : null;
    check("[가드] resolveTeamName(teamId) = 과일(T)", resolved === "과일(T)", String(resolved));

    const { data: anyWeek } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .order("start_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const weekId = (anyWeek as { id: string } | null)?.id ?? null;

    if (teamId && weekId) {
      // 저장 전 헤더 수 스냅샷.
      const beforeCount = async () => {
        const { count } = await supabaseAdmin
          .from("cluster4_experience_part_submissions")
          .select("id", { count: "exact", head: true })
          .eq("organization_slug", "oranke")
          .eq("week_id", weekId)
          .eq("team_id", teamId)
          .eq("part_name", "오렌지");
        return count ?? 0;
      };
      const before = await beforeCount();
      await expectThrow("[저장] 테스트팀에 실사용자 cell → savePartSubmission 중단", () =>
        savePartSubmission({
          organization: "oranke",
          weekId,
          teamId,
          part: "오렌지",
          submittedBy: null,
          cells: [{ crewUserId: realUserId, lineType: "derivation", checked: true, score: 5 }],
        }),
      );
      const after = await beforeCount();
      check("[저장] 거부 시 헤더 미생성(write 없음)", before === after, `before=${before} after=${after}`);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
