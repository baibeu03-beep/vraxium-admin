// 검증(READ-ONLY) — Phase 4: teams/crews/members mode 스코프 + operating 변화량 보고.
//   npx tsx --env-file=.env.local scripts/verify-phase4-endpoints-scope.ts
// DB write 0. snapshot 무접촉. resolver(SoT=test_user_markers) 일치 확인.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { isTestTeam } from "@/lib/cluster4ExperienceTestScope";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { listMembers } from "@/lib/adminMembersData";

const ORG = "oranke";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function main() {
  const testSet = await fetchTestUserMarkerIds();

  // ── 1) teams: cluster4_teams 직접 → mode 필터 재현 ──
  const { data: teamRows } = await supabaseAdmin
    .from("cluster4_teams").select("team_name,organization_slug,is_active")
    .eq("organization_slug", ORG).eq("is_active", true);
  const all = ((teamRows ?? []) as { team_name: string; organization_slug: string }[]);
  const opTeams = all.filter((t) => !isTestTeam(t.organization_slug, t.team_name)).map((t) => t.team_name);
  const tsTeams = all.filter((t) => isTestTeam(t.organization_slug, t.team_name)).map((t) => t.team_name);
  ck("[teams] operating 팀 목록에 (T) 0개", opTeams.every((t) => !/\(T\)$/.test(t)), `op=${opTeams.join(",")}`);
  ck("[teams] test 팀 목록 = (T)만 3개", tsTeams.length === 3 && tsTeams.every((t) => /\(T\)$/.test(t)), `test=${tsTeams.join(",")}`);

  // ── 2) crews(direct) ──
  const crewsOp = await listCrewsForTargetSelection({ organization: ORG });
  const crewsTs = await listCrewsForTargetSelection({ organization: ORG, mode: "test" });
  ck("[crews] operating 에 test_user_markers 0명",
    crewsOp.every((c) => !testSet.has(c.userId)), `total=${crewsOp.length} test혼입=${crewsOp.filter((c) => testSet.has(c.userId)).length}`);
  ck("[crews] test = 전원 test_user_markers",
    crewsTs.length > 0 && crewsTs.every((c) => testSet.has(c.userId)), `total=${crewsTs.length}`);
  ck("[crews] operating ∩ test = ∅", crewsOp.filter((c) => crewsTs.some((t) => t.userId === c.userId)).length === 0);

  // crews operating 변화량 보고(기존=무필터 전체 vs 신규=실사용자만).
  const crewsNoFilterCount = (await (async () => {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id").eq("organization_slug", ORG);
    return (data ?? []).length;
  })());
  console.log(`  [Δ crews operating] org 프로필 ${crewsNoFilterCount}명 중 실사용자 ${crewsOp.length}명(테스트 ${crewsNoFilterCount - crewsOp.length}명 제외) — 구 동작은 테스트 포함`);

  // ── 3) members(direct) ──
  const memOp = await listMembers({ organization: ORG, limit: 500 });
  const memTs = await listMembers({ organization: ORG, limit: 500, mode: "test" });
  ck("[members] operating 에 test_user_markers 0명",
    memOp.members.every((m) => !testSet.has(m.userId)), `total=${memOp.total} 페이지 ${memOp.members.length} test혼입=${memOp.members.filter((m) => testSet.has(m.userId)).length}`);
  ck("[members] test = 전원 test_user_markers",
    memTs.members.length > 0 && memTs.members.every((m) => testSet.has(m.userId)), `total=${memTs.total} 페이지 ${memTs.members.length}`);

  // members operating 변화량 보고.
  const memDefault = await listMembers({ organization: ORG, limit: 1 }); // operating total
  console.log(`  [Δ members operating] operating total=${memOp.total} · test total=${memTs.total} (구 동작은 두 모집단 합산 표시 — operating 에서 테스트 ${memTs.total}명이 빠짐)`);
  void memDefault;

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
