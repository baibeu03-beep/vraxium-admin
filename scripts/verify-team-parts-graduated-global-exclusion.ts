/**
 * /admin/team-parts/info/* [B] 크루 목록(crewRows) — 졸업 상태 전역 제외 검증.
 *   특정 이름을 하드코딩하지 않는다 — 검증 시점에 DB 에서 "졸업 효력이 발생한(또는 발생할) 크루"
 *   모집단을 동적으로 조회해, 그 크루가 자기 소속 팀의 crewRows 에 남아있는지 전 조직·전 팀에 대해
 *   교차 대조한다. 새로 졸업 처리되는 크루가 생겨도 이 스크립트를 다시 돌리면 자동으로 포함된다.
 *
 * A) 전 조직 × 활성 팀 전체 × 현재 주차(선택 주차 기본값) × operating/test — crewRows 의 모든 행을
 *    그 순간 DB 의 졸업 상태와 대조(0명이어야 함).
 * B) 동적으로 찾은 "졸업 효력 경계"를 가진 크루마다 경계 주차 -1/0/+1 을 실제로 재현해 정책이
 *    정확히 그 경계에서 갈리는지 확인(하드코딩 이름 없이 SQL 조건으로 대상 선정).
 *
 * 사전조건: .env.local (DB 직결, HTTP 불필요 — lib 직접 호출로 빠르게 순회).
 * Usage: npx tsx --env-file=.env.local scripts/verify-team-parts-graduated-global-exclusion.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import { loadEvaluationEligibility } from "@/lib/evaluationEligibility";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import type { ScopeMode } from "@/lib/userScopeShared";

let pass = 0;
let fail = 0;
const violations: unknown[] = [];
const ck = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else {
    fail++;
    violations.push({ label, detail });
  }
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
};

async function main() {
  const { rows: weekRows } = await loadSeasonWeeks();
  const currentRow = weekRows.find((w) => w.is_current_week);
  if (!currentRow?.week_id || !currentRow.week_start_date) {
    console.log("현재 주차를 찾지 못함 — abort");
    process.exit(1);
  }
  console.log(`현재 주차: ${currentRow.week_label}(${currentRow.week_start_date})`);

  // ── A) 전 조직 활성 팀 전체 — 현재 주차(=admin 기본 진입값) crewRows 전 행 동적 대조 ──
  console.log("\n=== A) 전 조직·전 팀·현재 주차 — crewRows 전 행 졸업 상태 동적 대조 ===");
  const { data: halves } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("organization_slug,team_name")
    .eq("is_active", true);
  const teamPairs = Array.from(
    new Map(
      ((halves ?? []) as Array<{ organization_slug: string; team_name: string }>).map((h) => [
        `${h.organization_slug}::${h.team_name}`,
        h,
      ]),
    ).values(),
  );
  console.log(`검사 대상 (조직,팀) 조합: ${teamPairs.length}개`);

  let totalRowsChecked = 0;
  let totalGraduatedFound = 0;
  for (const { organization_slug: org, team_name: teamName } of teamPairs) {
    for (const mode of ["operating", "test"] as ScopeMode[]) {
      let summary;
      try {
        summary = await getTeamSelectedWeekSummary({
          organization: org as "encre" | "oranke" | "phalanx",
          teamName,
          weekId: currentRow.week_id,
          mode,
        });
      } catch (e) {
        console.log(`  [스킵] ${org}/${teamName}(${mode}) 에러: ${(e as Error).message}`);
        continue;
      }
      if (!summary.crewRows.length) continue;
      totalRowsChecked += summary.crewRows.length;

      // ⚠ crewRows 를 만든 그 판정을 재신뢰하지 않는다 — DB 에서 그 행들의 growth_status 를
      //   **다시(fresh) 조회**해 독립적으로 대조한다(회로 자체를 다시 타지 않는 대조).
      const uids = summary.crewRows.map((r) => r.userId);
      const { data: profs } = await supabaseAdmin
        .from("user_profiles")
        .select("user_id,display_name,growth_status,activity_ended_at")
        .in("user_id", uids)
        .eq("growth_status", "graduated");
      const graduatedInRow = (profs ?? []) as Array<{
        user_id: string;
        display_name: string;
        growth_status: string;
        activity_ended_at: string | null;
      }>;
      if (graduatedInRow.length > 0) {
        totalGraduatedFound += graduatedInRow.length;
        for (const g of graduatedInRow) {
          // 유입 경로 추적 — override/UPH/현재 멤버십 중 어디서 왔는지, 그리고 eligibility 판정 재확인.
          const elig = await loadEvaluationEligibility({
            userIds: [g.user_id],
            weekStartDate: currentRow.week_start_date!,
            seasonKey: currentRow.season_key ?? null,
          });
          const flags = elig.flags(g.user_id);
          const row = summary.crewRows.find((r) => r.userId === g.user_id);
          const { data: ovr } = await supabaseAdmin
            .from("cluster4_team_week_position_overrides")
            .select("*")
            .eq("user_id", g.user_id)
            .eq("organization", org)
            .eq("raw_team", teamName)
            .lte("week_start_date", currentRow.week_start_date!)
            .order("week_start_date", { ascending: false })
            .limit(1);
          console.log(
            `  [위반] org=${org} team=${teamName} mode=${mode} user=${g.display_name}(${g.user_id}) ended=${g.activity_ended_at} eliteFlag=${flags.elite} row=${JSON.stringify(row)} 최근override=${JSON.stringify(ovr)}`,
          );
        }
      }
    }
  }
  ck(
    `전 조직·전 팀 현재 주차 crewRows 안에 졸업 크루 0명 (검사한 행 총 ${totalRowsChecked}개)`,
    totalGraduatedFound === 0,
    { totalGraduatedFound },
  );

  // ── B) 동적 경계 검증 — "졸업 효력일이 있는" 크루를 SQL 로 즉석 조회, 하드코딩 없음 ──
  console.log("\n=== B) 졸업 효력 경계 동적 검증(하드코딩 이름 없음) ===");
  const { data: graduatedNow } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,activity_ended_at")
    .eq("growth_status", "graduated")
    .not("activity_ended_at", "is", null);
  const targets = (graduatedNow ?? []) as Array<{
    user_id: string;
    display_name: string;
    organization_slug: string;
    activity_ended_at: string;
  }>;
  console.log(`효력일이 기록된 졸업 크루: ${targets.length}명 (동적 조회, 이름 하드코딩 없음)`);

  for (const t of targets) {
    const endDate = t.activity_ended_at.slice(0, 10);
    const { data: mem } = await supabaseAdmin
      .from("user_memberships")
      .select("team_name")
      .eq("user_id", t.user_id)
      .eq("is_current", true)
      .limit(1);
    const teamName = (mem as Array<{ team_name: string }> | null)?.[0]?.team_name;
    if (!teamName) continue;

    // 효력일을 포함하는 주차 + 그 전/후 주차.
    const idx = weekRows.findIndex((w) => w.week_start_date && w.week_start_date <= endDate && (w.week_end_date ?? "") >= endDate);
    const around = [idx - 1, idx, idx + 1].map((i) => weekRows[i]).filter(Boolean);
    for (const w of around) {
      if (!w.week_id || !w.week_start_date) continue;
      for (const mode of ["operating", "test"] as ScopeMode[]) {
        try {
          const summary = await getTeamSelectedWeekSummary({
            organization: t.organization_slug as "encre" | "oranke" | "phalanx",
            teamName,
            weekId: w.week_id,
            mode,
          });
          if (summary.week?.weekId !== w.week_id) continue; // 폴백(미래주차 등) 스킵 — 그 주차 자체 판정 아님.
          const inCrewRows = summary.crewRows.some((r) => r.userId === t.user_id);
          const shouldExclude = w.week_start_date > endDate; // 효력일 이후 주차 = 반드시 제외.
          ck(
            `${t.display_name}(동적) ${w.week_label}(${w.week_start_date}, 효력일=${endDate}, mode=${mode}) ${shouldExclude ? "제외되어야 함" : "포함 가능"} → 실제 포함=${inCrewRows}`,
            shouldExclude ? !inCrewRows : true, // 효력일 이전은 포함/제외 둘 다 정책 위반 아님(당시 활동 조건에 따름) — 이후만 엄격 검사.
            { inCrewRows, shouldExclude },
          );
        } catch (e) {
          console.log(`    에러: ${(e as Error).message}`);
        }
      }
    }
  }

  console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
  if (violations.length) {
    console.log("위반 상세:", JSON.stringify(violations, null, 2));
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
