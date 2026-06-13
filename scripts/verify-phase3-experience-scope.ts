// 검증(READ-ONLY) — Phase 3: 경험 라인개설 mode 스코프 이관.
//   npx tsx --env-file=.env.local scripts/verify-phase3-experience-scope.ts
// operating(기본)=실사용자만·테스트 팀 숨김 / test=테스트 유저만·테스트 팀만.
// DB write 0 (save 가드는 throw 전 검증·헤더 미생성으로 확인). snapshot 무접촉.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getExperienceLineManageSummary } from "@/lib/adminExperienceLineManage";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import {
  listPartCrews,
  listTeamParts,
  savePartSubmission,
} from "@/lib/adminExperiencePartInput";

const ORG = "oranke";
const TEST_TEAMS: Record<string, number> = { "과일(T)": 9, "음료(T)": 7, "콘텐츠실험(T)": 11 };

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};
async function expectThrow(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ck(label, false, "throw 기대했으나 통과");
  } catch (e) {
    ck(label, true, `차단됨: ${(e as Error).message.slice(0, 50)}…`);
  }
}

async function main() {
  const testSet = await fetchTestUserMarkerIds();

  // ── operating: 라인관리 요약 = 운영 팀만, 테스트 팀 숨김, 테스트 유저 0 ──
  const opSum = await getExperienceLineManageSummary(ORG);
  const opTeamNames = opSum.teams.map((t) => t.teamName);
  ck(
    "[operating] (T) 테스트 팀 숨김",
    Object.keys(TEST_TEAMS).every((t) => !opTeamNames.includes(t)),
    `teams=${JSON.stringify(opTeamNames)}`,
  );
  const fnb = opSum.teams.find((t) => t.teamName === "F&B");
  ck("[operating] 운영 팀(F&B) 존재·인원>0", !!fnb && fnb.headcount.total > 0, fnb && `total=${fnb.headcount.total}`);

  // ── test: 라인관리 요약 = (T) 팀만, 기대 인원 ──
  const tsSum = await getExperienceLineManageSummary(ORG, null, "test");
  const tsTeamNames = tsSum.teams.map((t) => t.teamName);
  ck(
    "[test] 테스트 팀만 노출",
    tsTeamNames.length === 3 && Object.keys(TEST_TEAMS).every((t) => tsTeamNames.includes(t)),
    `teams=${JSON.stringify(tsTeamNames)}`,
  );
  for (const [team, expected] of Object.entries(TEST_TEAMS)) {
    const t = tsSum.teams.find((x) => x.teamName === team);
    ck(
      `[test] ${team} headcount.total=${expected}`,
      t?.headcount.total === expected,
      `total=${t?.headcount.total} (일반 ${t?.headcount.normal}/파트장 ${t?.headcount.partLeader}/에이전트 ${t?.headcount.agent})`,
    );
  }
  // 역할 비-0 (요구사항: 인원/역할 표시).
  const fruit = tsSum.teams.find((x) => x.teamName === "과일(T)");
  ck("[test] 과일(T) 역할 비-0(파트장·에이전트>0)", !!fruit && fruit.headcount.partLeader > 0 && fruit.headcount.agent > 0);

  // ── part 그리드 모집단 ──
  // 운영 팀(F&B) operating → 테스트 유저 0.
  const fnbParts = await listTeamParts(ORG, "F&B");
  let opTestLeak = 0;
  for (const p of fnbParts) {
    const crews = await listPartCrews(ORG, "F&B", p);
    opTestLeak += crews.filter((c) => testSet.has(c.userId)).length;
  }
  ck("[operating] F&B 파트 크루에 테스트 유저 0", opTestLeak === 0);

  // (T) 팀 operating → 빈 목록 / test → 테스트 유저만.
  const fruitPartsOp = await listTeamParts(ORG, "과일(T)");
  ck("[operating] 과일(T) 파트 목록 비어있음(테스트 유저 숨김)", fruitPartsOp.length === 0, `parts=${JSON.stringify(fruitPartsOp)}`);
  const fruitPartsTest = await listTeamParts(ORG, "과일(T)", "test");
  let testCrewTotal = 0;
  let testCrewNonMarker = 0;
  for (const p of fruitPartsTest) {
    const crews = await listPartCrews(ORG, "과일(T)", p, "test");
    testCrewTotal += crews.length;
    testCrewNonMarker += crews.filter((c) => !testSet.has(c.userId)).length;
  }
  ck("[test] 과일(T) 파트 크루 = 전원 test_user_markers", testCrewTotal > 0 && testCrewNonMarker === 0, `crews=${testCrewTotal} 비마커=${testCrewNonMarker}`);

  // ── 개설 완료 직전 검증(요구사항 #6): test 모드 보드 크루 전원 marker ──
  const teamRow = await supabaseAdmin
    .from("cluster4_teams")
    .select("id")
    .eq("organization_slug", ORG)
    .eq("team_name", "과일(T)")
    .maybeSingle();
  const teamId = (teamRow.data as { id: string } | null)?.id ?? null;
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const weekId = (wk as { id: string } | null)?.id ?? null;
  if (teamId && weekId) {
    const board = await getTeamOverallBoard(ORG, weekId, teamId, "과일(T)", "test");
    const crewIds = board.parts.flatMap((p) => p.crews.map((c) => c.userId));
    ck(
      "[개설검증#6] test 보드 크루(=개설 target 후보) 전원 test_user_markers",
      crewIds.length > 0 && crewIds.every((id) => testSet.has(id)),
      `crews=${crewIds.length}`,
    );

    // ── 저장 가드(#5): test 모드 + 실사용자 cell → 차단, 헤더 미생성 ──
    const { data: realProf } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", ORG)
      .limit(400);
    const realId =
      ((realProf ?? []) as { user_id: string }[]).map((r) => r.user_id).find((id) => !testSet.has(id)) ?? null;
    const part = fruitPartsTest[0];
    if (realId && part) {
      const hdrCount = async () =>
        (await supabaseAdmin
          .from("cluster4_experience_part_submissions")
          .select("id", { count: "exact", head: true })
          .eq("organization_slug", ORG)
          .eq("week_id", weekId)
          .eq("team_id", teamId)
          .eq("part_name", part)).count ?? 0;
      const before = await hdrCount();
      await expectThrow("[저장#5] test 모드 + 실사용자 cell → savePartSubmission 중단", () =>
        savePartSubmission({
          organization: ORG,
          weekId,
          teamId,
          part,
          submittedBy: null,
          cells: [{ crewUserId: realId, lineType: "derivation", checked: true, score: 5 }],
          mode: "test",
        }),
      );
      const after = await hdrCount();
      ck("[저장#5] 거부 시 헤더 미생성(write 없음)", before === after, `${before}→${after}`);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
