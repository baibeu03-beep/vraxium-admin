/**
 * 팀 상세 [A] 선택 주차 요약 데이터 정합 검증 — 실제 lib(getTeamSelectedWeekSummary)를 직접 호출해
 *   등식·매트릭스 일치(운용 파트 판정)·op==test DTO 정합을 확인한다(HTTP/브라우저 불필요).
 *   Usage: npx tsx --env-file=.env.local scripts/verify-team-selected-week-summary.ts
 */
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  loadHalfRows,
  resolveCurrentHalfKey,
  loadTeamPartsInfo,
} from "@/lib/adminTeamHalvesData";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";

const KO: Record<string, string> = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
let fail = 0;
const ck = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) fail++;
};

// 매트릭스의 특정 주차(weekStartDate) 컬럼에서 운용(●) 파트명 집합.
function matrixOperatedParts(
  matrix: { partNames: string[]; present: boolean[][] } | null,
  weekColumns: Array<{ weekStartDate: string }>,
  weekStart: string,
): Set<string> {
  const out = new Set<string>();
  if (!matrix) return out;
  const col = weekColumns.findIndex((c) => c.weekStartDate === weekStart);
  if (col < 0) return out;
  matrix.partNames.forEach((p, pi) => {
    if (matrix.present[pi]?.[col]) out.add(p);
  });
  return out;
}

async function main() {
  for (const org of ORGANIZATIONS) {
    const half = await resolveCurrentHalfKey();
    if (!half) continue;
    const rows = (await loadHalfRows(org, half, { activeOnly: true })).filter(
      (r) => r.is_qa_test === true, // QA env: operating→test 실효 스코프
    );
    if (rows.length === 0) {
      console.log(`\n[${KO[org]}] 팀 없음 — skip`);
      continue;
    }
    const team = rows[0];
    console.log(`\n[${KO[org]}] 팀=${team.team_name}`);

    // 현재 주차 요약 + 선택 가능 주차.
    const cur = await getTeamSelectedWeekSummary({ organization: org, teamName: team.team_name });
    ck(cur.week != null, `현재 주차 확정`);
    ck(cur.week?.isCurrentWeek === true, `기본 선택 = 현재 주차`);
    // 미래 주차 없음(선택 목록 최신 = 현재 주차).
    ck(cur.selectableWeeks[0]?.isCurrent === true, `선택 목록 최신 = 현재(미래 없음)`);

    // 대상 주차 = 현재 + 과거 1개(있으면).
    const targets = [cur.week!.weekId];
    const past = cur.selectableWeeks.find((w) => !w.isCurrent);
    if (past) targets.push(past.weekId);

    // 매트릭스(현재 반기) — 운용 파트 판정 대조용.
    const info = await loadTeamPartsInfo(org, half, undefined, "operating");
    const infoTeam = info.teams.find((t) => t.teamName === team.team_name) ?? null;

    for (const weekId of targets) {
      const s = await getTeamSelectedWeekSummary({ organization: org, teamName: team.team_name, weekId });
      const w = s.week!;
      const tag = `[${KO[org]} ${w.label}]`;

      // 등식 1: 전체 = 정규 + 심화
      ck(s.crew.total === s.crew.regular + s.crew.advanced, `${tag} 전체=정규+심화 (${s.crew.total}=${s.crew.regular}+${s.crew.advanced})`);
      // 등식 2: 전체 = 성공 + 실패 + 휴식 + running + tallying
      const g = s.growth;
      ck(s.crew.total === g.success + g.failure + g.rest + g.running + g.tallying,
        `${tag} 전체=성공+실패+휴식+진행+집계 (${s.crew.total}=${g.success}+${g.failure}+${g.rest}+${g.running}+${g.tallying})`);
      // 운용 파트: 모두 crewCount>=1
      ck(s.operatedParts.every((p) => p.crewCount >= 1), `${tag} 운용 파트 crewCount>=1`);
      // 운용 파트 == 매트릭스 운용 셀(같은 주차)
      const mset = matrixOperatedParts(infoTeam?.partWeekMatrix ?? null, info.weekColumns, w.weekStartDate);
      const sset = new Set(s.operatedParts.map((p) => p.partName));
      const same = mset.size === sset.size && [...sset].every((p) => mset.has(p));
      ck(same, `${tag} 운용 파트 == 매트릭스 셀 (A=[${[...sset].join(",")}] 표=[${[...mset].join(",")}])`);
    }

    // op == test DTO 키/구조 동일.
    const opS = await getTeamSelectedWeekSummary({ organization: org, teamName: team.team_name, mode: "operating" });
    const tsS = await getTeamSelectedWeekSummary({ organization: org, teamName: team.team_name, mode: "test" });
    const keys = (o: object) => Object.keys(o).sort().join(",");
    ck(keys(opS) === keys(tsS) && keys(opS.crew) === keys(tsS.crew) && keys(opS.growth) === keys(tsS.growth),
      `[${KO[org]}] op/test DTO 키 동일`);
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
