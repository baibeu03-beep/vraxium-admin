/**
 * READ-ONLY 진단: 실무 경험 라인 개설 팀/파트 드롭다운 스코프 정합성.
 *   npx tsx --env-file=.env.local scripts/diag-experience-team-dropdown-scope.ts
 *
 * 확인:
 *   A) 각 org 활성 cluster4_teams 팀명 (isTestTeam 분류)
 *   B) 각 org 테스트 유저(test_user_markers, is_current) 실제 소속 team_name → part_name 분포
 *   C) listTeams(org, 'operating') vs listTeams(org, 'test') 결과 (QA_FIXED 반영 전 literal)
 *   D) 각 (T) 팀에 실제 테스트 유저가 있는지 / 테스트 유저 팀이 (T) allowlist 밖인지
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { listTeams } from "@/lib/adminExperienceLineData";
import { isTestTeam, TEST_TEAM_SCOPE } from "@/lib/cluster4ExperienceTestScope";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

const ORGS = ["encre", "oranke", "phalanx"];

function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function main() {
  console.log(`QA_HIDE_REAL_USERS = ${QA_HIDE_REAL_USERS}\n`);
  const testIds = [...(await fetchTestUserMarkerIds())];
  console.log(`test_user_markers 총 ${testIds.length}명\n`);

  // 테스트 유저 프로필(org) + 현재 멤버십(team/part)
  const profOrg = new Map<string, string | null>();
  for (const part of chunk(testIds, 800)) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", part);
    for (const r of (data ?? []) as any[]) profOrg.set(r.user_id, r.organization_slug);
  }
  const mem = new Map<string, { team: string | null; part: string | null; state: string | null }>();
  for (const part of chunk(testIds, 800)) {
    const { data } = await supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_state,is_current")
      .in("user_id", part);
    for (const r of (data ?? []) as any[]) {
      const ex = mem.get(r.user_id);
      if (!ex || (r.is_current && !ex)) {
        mem.set(r.user_id, { team: r.team_name, part: r.part_name, state: r.membership_state });
      }
    }
  }

  for (const org of ORGS) {
    console.log(`\n════════ ORG=${org} ════════`);

    // A) 활성 cluster4_teams
    const { data: teamRows } = await supabaseAdmin
      .from("cluster4_teams")
      .select("team_name,is_active")
      .eq("organization_slug", org)
      .eq("is_active", true)
      .order("team_name");
    const teamNames = (teamRows ?? []).map((r: any) => r.team_name);
    console.log(`A) 활성 cluster4_teams (${teamNames.length}):`);
    console.log(`   (T)팀 : ${teamNames.filter((n: string) => isTestTeam(org, n)).join(", ") || "(없음)"}`);
    console.log(`   운영팀: ${teamNames.filter((n: string) => !isTestTeam(org, n)).join(", ") || "(없음)"}`);
    console.log(`   allowlist(TEST_TEAM_SCOPE): ${[...(TEST_TEAM_SCOPE[org] ?? [])].join(", ")}`);

    // B) 테스트 유저 실제 소속 팀→파트
    const orgTestIds = testIds.filter((id) => profOrg.get(id) === org);
    const byTeam = new Map<string, Map<string, number>>();
    let noMem = 0;
    for (const id of orgTestIds) {
      const m = mem.get(id);
      if (!m || !m.team) { noMem++; continue; }
      const pm = byTeam.get(m.team) ?? new Map<string, number>();
      const pk = m.part ?? "(null)";
      pm.set(pk, (pm.get(pk) ?? 0) + 1);
      byTeam.set(m.team, pm);
    }
    console.log(`B) 테스트 유저 ${orgTestIds.length}명 실제 소속 (멤버십 없음 ${noMem}명):`);
    for (const [team, pm] of byTeam) {
      const flag = isTestTeam(org, team) ? "✓(T)등재" : "✗allowlist밖";
      const parts = [...pm.entries()].map(([p, c]) => `${p}×${c}`).join(", ");
      console.log(`   [${flag}] "${team}" → ${parts}`);
    }

    // C) listTeams literal
    const opTeams = (await listTeams(org, "operating")).map((t) => t.teamName);
    const tsTeams = (await listTeams(org, "test")).map((t) => t.teamName);
    console.log(`C) listTeams(operating)=[${opTeams.join(", ")}]`);
    console.log(`   listTeams(test)     =[${tsTeams.join(", ")}]`);

    // D) 불일치 요약
    const testTeamsWithUsers = new Set([...byTeam.keys()].filter((t) => byTeam.get(t)!.size > 0));
    const emptyTTeams = teamNames.filter((n: string) => isTestTeam(org, n) && !testTeamsWithUsers.has(n));
    const usersOutsideAllowlist = [...testTeamsWithUsers].filter((t) => !isTestTeam(org, t));
    console.log(`D) (T)등재인데 실 테스트유저 0명: [${emptyTTeams.join(", ") || "없음"}]`);
    console.log(`   실 테스트유저 있는데 allowlist 밖: [${usersOutsideAllowlist.join(", ") || "없음"}]`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
