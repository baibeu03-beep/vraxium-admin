/**
 * 팀별 현재 시점 크루 수(클러빙/정규/심화) 데이터 정합 검증 — 실제 lib(loadTeamPartsInfo)의 currentCrew 와
 *   DB 원천을 독립 재계산해 대조한다. 개인 휴식 포함 여부·세 등식(클러빙=정규+심화)도 확인.
 *   Usage: npx tsx --env-file=.env.local scripts/verify-team-detail-crew.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveUserScope } from "@/lib/userScope";
import { memberStatusLabel } from "@/lib/adminMembersTypes";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  loadTeamPartsInfo,
  resolveCurrentHalfKey,
} from "@/lib/adminTeamHalvesData";

const KO: Record<string, string> = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
let fail = 0;
const ck = (cond: boolean, label: string) => {
  if (!cond) { fail++; console.log(`  ✗ ${label}`); }
};

const isCrewLabel = (l: string) =>
  l === "일반" || l === "크루" || l === "심화(파트장)" || l === "심화(에이전트)";
const isAdvanced = (l: string) => l === "심화(파트장)" || l === "심화(에이전트)";

async function main() {
  const half = await resolveCurrentHalfKey();
  console.log(`현재 반기: ${half}\n`);
  console.log("| 클럽 | 팀 | 클러빙 | 정규 | 심화 | 휴식포함 | API일치 | 등식 |");
  console.log("| --- | --- | --: | --: | --: | --: | --- | --- |");

  for (const org of ORGANIZATIONS) {
    const info = await loadTeamPartsInfo(org, half, undefined, "operating");

    // DB 독립 재계산 원천: org 로스터(super 제외) ∩ operating 스코프.
    const { data: profs } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,role")
      .eq("organization_slug", org)
      .or(SUPER_ADMIN_EXCLUDE_OR);
    const scope = await resolveUserScope("operating", null);
    const roleByUser = new Map<string, string | null>();
    for (const p of (profs ?? []) as Array<{ user_id: string; role: string | null }>)
      if (scope.includes(p.user_id)) roleByUser.set(p.user_id, p.role);
    const uids = [...roleByUser.keys()];

    // is_current 멤버십(팀명·레벨·상태) — 개인 휴식 포함 여부 판정용으로 membership_state 도 가져온다.
    const memByUser = new Map<string, { team: string | null; level: string | null; state: string | null }>();
    for (let i = 0; i < uids.length; i += 100) {
      const chunk = uids.slice(i, i + 100);
      if (chunk.length === 0) break;
      const { data: mems } = await supabaseAdmin
        .from("user_memberships")
        .select("user_id,team_name,membership_level,membership_state,is_current")
        .in("user_id", chunk)
        .eq("is_current", true);
      for (const m of (mems ?? []) as Array<{
        user_id: string; team_name: string | null; membership_level: string | null; membership_state: string | null;
      }>) {
        if (!memByUser.has(m.user_id))
          memByUser.set(m.user_id, { team: m.team_name?.trim() ?? null, level: m.membership_level, state: m.membership_state });
      }
    }

    for (const team of info.teams) {
      const withRest = { clubbing: 0, regular: 0, advanced: 0 };
      let restIncluded = 0;
      for (const [uid, mem] of memByUser) {
        if (mem.team !== team.teamName) continue;
        const label = memberStatusLabel(roleByUser.get(uid) ?? null, mem.level ?? null);
        if (!isCrewLabel(label)) continue;
        withRest.clubbing++;
        if (isAdvanced(label)) withRest.advanced++;
        else withRest.regular++;
        if (mem.state === "rest") restIncluded++;
      }
      const api = team.currentCrew ?? { clubbingCount: 0, regularCrewCount: 0, advancedCrewCount: 0 };
      const apiMatch =
        api.clubbingCount === withRest.clubbing &&
        api.regularCrewCount === withRest.regular &&
        api.advancedCrewCount === withRest.advanced;
      const eq = withRest.clubbing === withRest.regular + withRest.advanced;
      ck(apiMatch, `[${org}] ${team.teamName} API==DB (api=${JSON.stringify(api)} db=${JSON.stringify(withRest)})`);
      ck(eq, `[${org}] ${team.teamName} 등식 클러빙=정규+심화`);
      console.log(
        `| ${KO[org]} | ${team.teamName} | ${withRest.clubbing} | ${withRest.regular} | ${withRest.advanced} | ${restIncluded} | ${apiMatch ? "PASS" : "FAIL"} | ${eq ? "PASS" : "FAIL"} |`,
      );
    }
  }
  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
