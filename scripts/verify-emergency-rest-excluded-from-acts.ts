/**
 * 회귀 검증: 긴급 휴식(origin='emergency_rest') 내부 액트가 활동 관리(액트 체크 관리)의
 *   변동 액트 목록·집계(변동/전체/체크율)에 유입되지 않는지 — 공통 loader(SoT) 직접 호출.
 *
 *   방법: 동일 (org, week, scope_mode) 에 2개 process_irregular_acts 시드
 *     A) origin='emergency_rest' (긴급 휴식 Po.C 내부 액트 — 제외돼야 함)
 *     B) origin=null            (일반 변동 액트 — 노출돼야 함)
 *   → loadTeamPartsInfoActCheckManagement 결과에서 A 부재·B 존재, 변동/전체 카운트에 A 미반영 확인.
 *   순수 표시 계층 테스트(원장/vacation_requests/accrual 무접촉) — 종료 시 시드 2행 삭제.
 *
 *   npx tsx --env-file=.env.local scripts/verify-emergency-rest-excluded-from-acts.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";

let failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

const REST_ACT_ID = "0c1e0000-0000-4000-8000-0000000000e1"; // 긴급 휴식 내부 액트(시드)
const NORMAL_ACT_ID = "0c1e0000-0000-4000-8000-0000000000e2"; // 일반 변동 액트(시드)

function findVariable(d: Awaited<ReturnType<typeof loadTeamPartsInfoActCheckManagement>>, id: string): boolean {
  const buckets = [
    ...Object.values(d.practicalInfo.variableActsByDay),
    ...Object.values(d.clubOverall.variableActsByDay),
    ...Object.values(d.practicalCompetency.variableActsByDay),
    ...d.practicalExperience.teams.flatMap((t) => Object.values(t.variableActsByDay)),
  ].flat();
  return buckets.some((v) => v.id === id);
}

async function seed(org: string, weekId: string) {
  const nowIso = new Date().toISOString();
  const common = {
    organization_slug: org,
    week_id: weekId,
    kind: "manual_grant",
    applicant_admin_id: null,
    applicant_admin_name: "[검증]",
    target_user_id: null,
    target_user_name: null,
    scope_mode: "operating",
    duration_minutes: null,
    reason: "verify",
    point_a: 0,
    point_b: 0,
    point_c: 2,
    crew_reaction: "partial",
    review_link: null,
    scheduled_check_at: nowIso,
    status: "completed",
    completed_at: nowIso,
  };
  const { error } = await supabaseAdmin.from("process_irregular_acts").insert([
    { id: REST_ACT_ID, origin: "emergency_rest", act_name: "긴급 휴식 · [검증]크루", ...common },
    { id: NORMAL_ACT_ID, origin: null, act_name: "[검증] 일반 변동 액트", ...common },
  ]);
  if (error) throw new Error(`seed 실패(process_irregular_acts.origin 컬럼 미적용 가능): ${error.message}`);
}

async function cleanup() {
  await supabaseAdmin.from("process_irregular_acts").delete().in("id", [REST_ACT_ID, NORMAL_ACT_ID]);
}

async function main() {
  const { rows } = await loadSeasonWeeks();
  const week = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = week.week_id;
  const org = ORGANIZATIONS[0];
  console.log(`   org=${org} week=${week.week_label} id=${weekId.slice(0, 8)}`);

  // 시드 전 기준값(변동/전체) — 시드가 정확히 +1(정상만) 되는지 델타로 검증.
  const before = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });

  await seed(org, weekId);
  try {
    const after = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "operating" });

    // A) 긴급 휴식 내부 액트 — 변동 목록·주차/정보 집계 어디에도 없어야 함.
    check("긴급 휴식 액트가 변동 목록에 없음", !findVariable(after, REST_ACT_ID));
    // B) 일반 변동 액트 — 정상 노출(info 귀속).
    check("일반 변동 액트는 변동 목록에 노출", findVariable(after, NORMAL_ACT_ID));

    // 집계 델타: 정상 1건만 반영(+1), 긴급 휴식은 미반영.
    check("주차 전체 변동 수 델타=+1(정상만)",
      after.summary.variableActs - before.summary.variableActs === 1,
      { before: before.summary.variableActs, after: after.summary.variableActs });
    check("주차 전체 액트 수 델타=+1(정상만)",
      after.summary.totalActs - before.summary.totalActs === 1,
      { before: before.summary.totalActs, after: after.summary.totalActs });
    check("실무 정보 변동 수 델타=+1(정상만)",
      after.practicalInfo.summary.variableActs - before.practicalInfo.summary.variableActs === 1,
      { before: before.practicalInfo.summary.variableActs, after: after.practicalInfo.summary.variableActs });

    // 체크율/가동은 정규 액트(process_acts) 기준 — 변동 액트 유무와 무관해야 함(회귀 방지).
    check("가동 수 불변(변동 액트는 체크율/가동 무관)",
      after.practicalInfo.summary.activeActs === before.practicalInfo.summary.activeActs);
    check("체크율 불변(변동 액트는 체크율/가동 무관)",
      after.practicalInfo.summary.actCheckRate === before.practicalInfo.summary.actCheckRate);

    // 일반/테스트 모드 동일 DTO 형상(테스트 모드에도 긴급 휴식 미유입 — 시드는 operating 스코프라 test 는 0).
    const afterTest = await loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode: "test" });
    check("test 모드에도 긴급 휴식 액트 미노출", !findVariable(afterTest, REST_ACT_ID));
  } finally {
    await cleanup();
    console.log("   (시드 2행 정리 완료)");
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); cleanup().finally(() => process.exit(1)); });
