// READ-ONLY 진단 — 실무 경험 [팀 총괄] 에서 [개설 검수] / [개설 완료] 게이트를 실제로 통과할 수
//   있는 (org, weekId, teamId, mode) 후보를 찾는다. 파트장 라인명 누락 안내(스크롤/강조) 브라우저
//   검증 스크립트의 진입 URL 을 고르기 위한 보조 도구. mutation 없음.
//   run: npx tsx --env-file=.env.local scripts/diag-experience-overall-open-candidates.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamOverallBoard } from "@/lib/adminExperienceTeamOverall";
import { resolveTeamNameById } from "@/lib/experienceImpersonation";

const ORGS = ["encre", "oranke", "phalanx"] as const;

async function main() {
  // 최근 주차 운영 설정(open_confirmed) 중 실무 경험 개설 대상 주차 후보.
  const { data: configs } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,open_confirmed,config,updated_at")
    .eq("open_confirmed", true)
    .order("updated_at", { ascending: false })
    .limit(60);

  const rows = (configs ?? []) as Array<{
    week_id: string;
    organization_slug: string;
    config: Record<string, unknown> | null;
  }>;
  console.log(`[open_confirmed configs] ${rows.length}건`);

  for (const row of rows) {
    if (!(ORGS as readonly string[]).includes(row.organization_slug)) continue;
    // config.practicalExperience = { [teamId]: { derive, analysis, research, expansion, management } }.
    const pe = (
      row.config as {
        practicalExperience?: Record<string, boolean | Record<string, boolean>>;
      } | null
    )?.practicalExperience;
    const teamIds = Object.entries(pe ?? {})
      .filter(([, v]) =>
        typeof v === "boolean" ? v : Object.values(v ?? {}).some(Boolean),
      )
      .map(([k]) => k);
    if (teamIds.length === 0) continue;
    for (const teamId of teamIds) {
      const teamName = await resolveTeamNameById(teamId).catch(() => null);
      if (!teamName) continue;
      for (const mode of ["operating", "test"] as const) {
        try {
          const board = await getTeamOverallBoard(
            row.organization_slug,
            row.week_id,
            teamId,
            teamName,
            mode,
          );
          const crews = board.parts.flatMap((p) => p.crews);
          const leaders = crews.filter((c) => c.isPartLeader);
          if (!board.canOpen || leaders.length === 0) continue;
          console.log(
            [
              `org=${row.organization_slug}`,
              `week=${row.week_id}`,
              `team=${teamName}(${teamId})`,
              `mode=${mode}`,
              `status=${board.status}`,
              `canOpen=${board.canOpen}`,
              `allPartsApplied=${board.application?.allPartsApplied}`,
              `leaders=${leaders.length}`,
              `crews=${crews.length}`,
            ].join(" · "),
          );
        } catch (err) {
          console.log(
            `  (load 실패 ${row.organization_slug}/${row.week_id}/${teamName}/${mode}) ${(err as Error)?.message}`,
          );
        }
      }
    }
  }
}

void main();
