// 실무 경험 파트장 입력 — direct 함수 검증.
//   npx tsx --env-file=.env.local scripts/verify-experience-part-input.ts [org]
//
// 데이터 레이어를 직접 호출(supabaseAdmin, 무인증)해 파트/크루/신청/집계를 출력한다.
// HTTP 응답(GET /api/admin/cluster4/experience/part-input)과 동일 구조여야 한다(세션 필요).

import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getPartSubmission,
  getTeamOverall,
  listPartCrews,
  listTeamParts,
} from "@/lib/adminExperiencePartInput";

async function main() {
  const org = process.argv[2] ?? "oranke";

  // 대상 주차(개설 대상, 금요일 경계).
  const todayIso = new Date().toISOString().slice(0, 10);
  const ms = getOpenableWeekStartMs(todayIso);
  const info = ms != null ? describeWeekByStartMs(ms) : null;
  let weekId: string | null = null;
  if (info) {
    const { data } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("iso_year", info.isoYear)
      .eq("iso_week", info.isoWeek)
      .maybeSingle();
    weekId = (data as { id: string } | null)?.id ?? null;
  }

  // 첫 팀.
  const { data: teamRows } = await supabaseAdmin
    .from("cluster4_teams")
    .select("id,team_name")
    .eq("organization_slug", org)
    .eq("is_active", true)
    .order("team_name")
    .limit(1);
  const team = (teamRows ?? [])[0] as { id: string; team_name: string } | undefined;

  console.log("org:", org, "weekId:", weekId, "team:", team?.team_name ?? null);
  if (!team || !weekId) {
    console.log("team/week 없음 — 종료");
    return;
  }

  const parts = await listTeamParts(org, team.team_name);
  console.log("parts:", parts);

  const firstPart = parts[0];
  if (firstPart) {
    const crews = await listPartCrews(org, team.team_name, firstPart);
    console.log(`crews(${firstPart}):`, JSON.stringify(crews, null, 2));
    const sub = await getPartSubmission(org, weekId, team.id, firstPart);
    console.log(`submission(${firstPart}):`, JSON.stringify(sub, null, 2));
  }

  const overall = await getTeamOverall(org, weekId, team.id, team.team_name);
  console.log("teamOverall:", JSON.stringify(overall, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
