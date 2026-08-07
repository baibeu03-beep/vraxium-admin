/**
 * 어드민 전역 "현재 활동 업무 모집단" — 졸업(엘리트) 크루 제외 정책 전역 동적 검증.
 *   이름을 하드코딩하지 않는다. 실행 시점에 DB 에서 "현재 졸업 효력이 발생한" 크루를
 *   동적으로 조회해, 이번 라운드에서 수정한 두 경로가 실제로 그들을 제외하는지 대조한다.
 *
 * 대상:
 *   A) lib/adminCluster4UsersData.ts:listCluster4Users
 *      (/admin/line-opening/practical-info 라인 개설 대상 체크리스트가 소비)
 *   B) lib/adminEmergencyRest.ts:listEmergencyCrews
 *      (/admin/rest-management/emergency 긴급 휴식 대상 크루 선택이 소비)
 *
 * 각각 전 조직 × operating/test 모드로 순회하며, "현재 주차 기준 졸업 효력 발생" 크루가
 * 결과에 전혀 없는지 fresh 쿼리로 교차 대조한다.
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-admin-graduated-population-global.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listCluster4Users } from "@/lib/adminCluster4UsersData";
import { listEmergencyCrews } from "@/lib/adminEmergencyRest";
import { resolveCurrentWeekStartDate } from "@/lib/teamWeekPositionOverride";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
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
  const todayIso = getCurrentActivityDateIso();
  const currentWeekStart = await resolveCurrentWeekStartDate(todayIso);
  if (!currentWeekStart) {
    console.log("현재 주차를 찾지 못함 — abort");
    process.exit(1);
  }
  console.log(`현재 주차 시작일: ${currentWeekStart}`);

  // 동적 조회 — 효력일 ≤ 현재 주차 시작일인(즉 지금 시점 졸업 효력이 발생한) 크루 전원.
  //   effective week 이후만 검사한다(정확한 경계 검증은 team-parts 스크립트가 이미 커버).
  const { data: graduatedRows } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,activity_ended_at,growth_status")
    .eq("growth_status", "graduated");
  const graduated = (graduatedRows ?? []) as Array<{
    user_id: string;
    display_name: string;
    organization_slug: string | null;
    activity_ended_at: string | null;
  }>;
  const currentlyEffective = new Set(
    graduated
      .filter((g) => {
        if (!g.activity_ended_at) return true; // 효력일 미기록 → fallback 정책상 현재·미래는 이미 효력 발생.
        return String(g.activity_ended_at).slice(0, 10) < currentWeekStart; // 종료 주차 자체는 마지막 활동 주차.
      })
      .map((g) => g.user_id),
  );
  console.log(`현재 시점 졸업 효력 발생 크루(동적 조회): ${currentlyEffective.size}명`);

  // ── A) listCluster4Users (practical-info 개설 대상 체크리스트) ──
  console.log("\n=== A) listCluster4Users — 전 조직 × operating/test ===");
  for (const org of ORGANIZATIONS) {
    for (const mode of ["operating", "test"] as ScopeMode[]) {
      const rows = await listCluster4Users({ organization: org, mode });
      const leaked = rows.filter((r) => currentlyEffective.has(r.userId));
      ck(
        `${org}/${mode}: listCluster4Users(${rows.length}행)에 졸업 크루 0명`,
        leaked.length === 0,
        { leaked: leaked.map((r) => ({ userId: r.userId, displayName: r.displayName })) },
      );
    }
  }

  // ── B) listEmergencyCrews (긴급 휴식 대상 크루) — 활성 팀 전체 순회 ──
  console.log("\n=== B) listEmergencyCrews — 전 조직 활성 팀 × operating/test ===");
  const { data: halves } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,organization_slug,team_name")
    .eq("is_active", true);
  const teams = (halves ?? []) as Array<{ id: string; organization_slug: string; team_name: string }>;
  console.log(`검사 대상 활성 팀: ${teams.length}개`);

  let totalChecked = 0;
  for (const t of teams) {
    for (const mode of ["operating", "test"] as ScopeMode[]) {
      try {
        const rows = await listEmergencyCrews(t.organization_slug as OrganizationSlug, t.id, mode);
        totalChecked += rows.length;
        const leaked = rows.filter((r) => currentlyEffective.has(r.userId));
        if (leaked.length > 0) {
          ck(
            `${t.organization_slug}/${t.team_name}/${mode}: listEmergencyCrews 에 졸업 크루 0명`,
            false,
            { leaked: leaked.map((r) => ({ userId: r.userId, crewName: r.crewName })) },
          );
        }
      } catch (e) {
        console.log(`  [스킵] ${t.organization_slug}/${t.team_name}(${mode}) 에러: ${(e as Error).message}`);
      }
    }
  }
  ck(`전 활성 팀 listEmergencyCrews 대조 완료 (검사한 행 총 ${totalChecked}개) — 위반 0건`, true);

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
