// 순수 SoT 검증 — 에이전트 개설신청/검수 권한 게이트 + 파트 신청 완료 판정.
// 실무 경험 허브 수정(에이전트 part_save 허용 · 검수 사전조건)의 핵심 로직만 HTTP 없이 검증한다.
import {
  assertImpersonationCapability,
  type ExperienceWriteAction,
  type ImpersonationActor,
} from "@/lib/experienceImpersonation";
import {
  resolveOverallApplicationReadiness,
} from "@/lib/experienceTeamOverallTypes";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
}

// active 임퍼소네이션에서 (actor, action) 이 허용되는가? (deny403 throw 여부)
function allowed(
  actor: ImpersonationActor,
  action: ExperienceWriteAction,
  targetTeamName: string | null,
  targetPart?: string | null,
): boolean {
  try {
    assertImpersonationCapability({ active: true, actor, action, targetTeamName, targetPart });
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 403) return false;
    throw e;
  }
}

const TEAM = "알파팀";
const agent: ImpersonationActor = { memberRole: "agent", teamName: TEAM, partName: "도출" };
const partLeader: ImpersonationActor = { memberRole: "part_leader", teamName: TEAM, partName: "도출" };
const teamLeader: ImpersonationActor = { memberRole: "team_leader", teamName: TEAM, partName: null };
const member: ImpersonationActor = { memberRole: "member", teamName: TEAM, partName: "도출" };

console.log("[1] 에이전트 — 모든 대상 파트 개설신청 + 검수 가능 / 개설·취소 불가");
check("agent part_save 자기팀 도출", allowed(agent, "part_save", TEAM, "도출"));
check("agent part_save 자기팀 분석(다른 파트도 가능)", allowed(agent, "part_save", TEAM, "분석"));
check("agent review 자기팀", allowed(agent, "review", TEAM));
check("agent open 불가", !allowed(agent, "open", TEAM));
check("agent cancel 불가", !allowed(agent, "cancel", TEAM));
check("agent part_save 타 팀 불가", !allowed(agent, "part_save", "베타팀", "도출"));
check("agent review 타 팀 불가", !allowed(agent, "review", "베타팀"));

console.log("[2] 파트장 — 자기 파트 개설신청만 / 검수·개설 불가");
check("partLeader part_save 자기 파트", allowed(partLeader, "part_save", TEAM, "도출"));
check("partLeader part_save 다른 파트 불가", !allowed(partLeader, "part_save", TEAM, "분석"));
check("partLeader review 불가", !allowed(partLeader, "review", TEAM));
check("partLeader open 불가", !allowed(partLeader, "open", TEAM));

console.log("[3] 팀장 — 자기팀 전권 / 일반 크루 — 전부 불가");
check("teamLeader part_save", allowed(teamLeader, "part_save", TEAM, "도출"));
check("teamLeader review", allowed(teamLeader, "review", TEAM));
check("teamLeader open", allowed(teamLeader, "open", TEAM));
check("teamLeader cancel", allowed(teamLeader, "cancel", TEAM));
check("member part_save 불가", !allowed(member, "part_save", TEAM, "도출"));
check("member review 불가", !allowed(member, "review", TEAM));

console.log("[4] allPartsApplied — 대상 0개=false, 일부 미신청=false, 전부 신청=true");
const r0 = resolveOverallApplicationReadiness([]);
check("대상 0개 → allPartsApplied=false (완료 오인 금지)", r0.allPartsApplied === false && r0.totalPartCount === 0);
const rSome = resolveOverallApplicationReadiness([
  { partName: "도출", submitted: true },
  { partName: "분석", submitted: false },
  { partName: "견문", submitted: false },
]);
check("일부 미신청 → allPartsApplied=false", rSome.allPartsApplied === false);
check("일부 미신청 → unappliedParts=[분석,견문]", JSON.stringify(rSome.unappliedParts) === JSON.stringify(["분석", "견문"]));
check("일부 미신청 → appliedPartCount=1 / total=3", rSome.appliedPartCount === 1 && rSome.totalPartCount === 3);
const rAll = resolveOverallApplicationReadiness([
  { partName: "도출", submitted: true },
  { partName: "분석", submitted: true },
]);
check("전부 신청 → allPartsApplied=true", rAll.allPartsApplied === true && rAll.unappliedParts.length === 0);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
