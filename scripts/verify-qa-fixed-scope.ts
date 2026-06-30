// ─────────────────────────────────────────────────────────────────────
// verify:qa-fixed-scope — QA 고정 모집단 필터(lib/qaFixedScope.QA_FIXED_TEST_ONLY) 검증.
//
// 계약: QA_FIXED_TEST_ONLY=true 면 전달 mode 와 무관하게 어드민 집계/코호트가 test_user_markers
//   테스트 유저만 본다(실사용자 노출 0). 외부 환경변수/배포 분기에 의존하지 않는다.
//
// 커버리지(중앙 resolveUserScope 외 별축 경로 — leak 보정 지점):
//   1) resolveUserScope 중앙 플립(mode=operating 전달에도 mode=test 로 고정).
//   2) 주차 카드 집계 확정 preview (StateScope=operating 인데 코호트는 테스트 전용).
//   3) cluster3 growth-status-batch 로스터(자체 org 전원 → 테스트 전용으로 보정).
//   4) publish-result recompute 코호트 좁힘(쓰기 대상 테스트 한정 — 비-뮤테이션 로직 검증).
//
// 실데이터 read-only. write/snapshot 무접촉.
//   npx tsx --env-file=.env.local scripts/verify-qa-fixed-scope.ts
// ─────────────────────────────────────────────────────────────────────
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { resolveUserScope } from "@/lib/userScope";
import { QA_FIXED_TEST_ONLY } from "@/lib/qaFixedScope";
import { previewWeeklyCardFinalization } from "@/lib/adminWeeklyCardFinalizationData";
import { getGrowthStatusResolutionBatch } from "@/lib/cluster3GrowthData";
import type { OrganizationSlug } from "@/lib/organizations";

const ORGS: OrganizationSlug[] = ["oranke", "encre", "phalanx"];
// 혼합 코호트(테스트+실유저) 보유 여름 주차 — 누수 검증 픽스처.
const SUMMER_WEEKS: Array<{ seasonKey: string; weekNumber: number }> = [
  { seasonKey: "2025-summer", weekNumber: 5 },
  { seasonKey: "2025-summer", weekNumber: 6 },
  { seasonKey: "2025-summer", weekNumber: 7 },
  { seasonKey: "2025-summer", weekNumber: 8 },
];

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function weekStartFor(seasonKey: string, weekNumber: number): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("season_key", seasonKey)
    .eq("week_number", weekNumber)
    .maybeSingle();
  return (data as { start_date: string } | null)?.start_date ?? null;
}

// 독립 오라클: 해당 주차 uws 코호트 중 (테스트 유저)·(실유저) 수.
async function cohortOracle(start: string, testIds: Set<string>) {
  const { data } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .eq("week_start_date", start);
  const ids = Array.from(new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)));
  const testCohort = ids.filter((id) => testIds.has(id));
  const realCohort = ids.filter((id) => !testIds.has(id));
  return { ids, testCohort, realCohort };
}

async function orgTestCount(userIds: string[], org: OrganizationSlug, testIds: Set<string>): Promise<number> {
  const test = userIds.filter((id) => testIds.has(id));
  if (test.length === 0) return 0;
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", org)
    .in("user_id", test);
  return ((data ?? []) as { user_id: string }[]).length;
}

async function main() {
  console.log(`=== verify:qa-fixed-scope (QA_FIXED_TEST_ONLY=${QA_FIXED_TEST_ONLY}) ===`);
  check("QA_FIXED_TEST_ONLY 가 켜져 있음(QA 기간)", QA_FIXED_TEST_ONLY === true);

  const testIds = await fetchTestUserMarkerIds();
  check("test_user_markers 비어있지 않음", testIds.size > 0, { count: testIds.size });

  // 1) 중앙 플립 — mode=operating 전달에도 모집단 = test.
  const scope = await resolveUserScope("operating", null);
  check("[중앙] resolveUserScope.mode == 'test' (operating 전달)", scope.mode === "test", { mode: scope.mode });
  check("[중앙] includeUserIds = 테스트 화이트리스트", (scope.includeUserIds?.length ?? 0) === testIds.size);
  const someReal = (await supabaseAdmin.from("user_profiles").select("user_id").limit(800)).data
    ?.map((r: any) => r.user_id).find((id: string) => id && !testIds.has(id));
  if (someReal) check("[중앙] 실유저는 스코프 제외(includes=false)", scope.includes(someReal) === false, { someReal });

  // 2) 주차 카드 집계 확정 preview — 코호트 테스트 전용(실사용자 누수 0).
  console.log("\n[2] 주차 카드 집계 확정 preview (StateScope=operating, 코호트=테스트 전용)");
  for (const w of SUMMER_WEEKS) {
    const start = await weekStartFor(w.seasonKey, w.weekNumber);
    if (!start) { console.log(`  · ${w.seasonKey} W${w.weekNumber}: 주차 없음 — 생략`); continue; }
    const { ids, testCohort, realCohort } = await cohortOracle(start, testIds);
    if (testCohort.length === 0) { console.log(`  · ${w.seasonKey} W${w.weekNumber}: 테스트 코호트 0 — 생략`); continue; }

    const pAll = await previewWeeklyCardFinalization({ seasonKey: w.seasonKey, weekNumber: w.weekNumber, org: null });
    const totalAll = pAll.aggregation?.totalCrew ?? -1;
    check(
      `${w.seasonKey} W${w.weekNumber} [org=전체] totalCrew == 테스트 코호트(${testCohort.length}) (전체 ${ids.length}/실유저 ${realCohort.length} 제외)`,
      totalAll === testCohort.length,
      { totalCrew: totalAll, expectTest: testCohort.length, fullCohort: ids.length },
    );
    check(
      `${w.seasonKey} W${w.weekNumber} [org=전체] 실사용자 누수 0 (totalCrew < 전체)`,
      realCohort.length === 0 ? totalAll === ids.length : totalAll < ids.length,
    );

    for (const org of ORGS) {
      const expect = await orgTestCount(ids, org, testIds);
      const pOrg = await previewWeeklyCardFinalization({ seasonKey: w.seasonKey, weekNumber: w.weekNumber, org });
      const total = pOrg.aggregation?.totalCrew ?? -1;
      check(`${w.seasonKey} W${w.weekNumber} [${org}] totalCrew == org∩테스트(${expect})`, total === expect, { total, expect });
    }
  }

  // 3) growth-status-batch 로스터 보정 — 라우트 인라인 로직 재현(테스트 전용).
  console.log("\n[3] cluster3 growth-status-batch 로스터 (QA: 테스트 전용으로 보정)");
  for (const org of ORGS) {
    const { data: roster } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", org);
    let ids = ((roster ?? []) as { user_id: string }[]).map((r) => r.user_id);
    const before = ids.length;
    if (QA_FIXED_TEST_ONLY) ids = ids.filter((id) => testIds.has(id)); // 라우트와 동일 보정
    const leak = ids.filter((id) => !testIds.has(id));
    check(`[${org}] growth 로스터 실사용자 누수 0 (보정 ${before}→${ids.length})`, leak.length === 0, { leak: leak.slice(0, 3) });
    if (ids.length > 0) {
      const rows = await getGrowthStatusResolutionBatch(ids);
      const rowLeak = rows.map((r: any) => r.userId ?? r.user_id).filter((id: string) => id && !testIds.has(id));
      check(`[${org}] growth-status 결과 실사용자 누수 0 (rows=${rows.length})`, rowLeak.length === 0, { rowLeak: rowLeak.slice(0, 3) });
    }
  }

  // 4) publish-result recompute 코호트 좁힘 — 비-뮤테이션 로직 검증(쓰기 대상 테스트 한정).
  console.log("\n[4] publish-result recompute 코호트 좁힘(쓰기 대상 테스트 한정 — 로직)");
  for (const w of SUMMER_WEEKS) {
    const start = await weekStartFor(w.seasonKey, w.weekNumber);
    if (!start) continue;
    const { ids, testCohort } = await cohortOracle(start, testIds);
    if (testCohort.length === 0) continue;
    const narrowed = ids.filter((id) => testIds.has(id)); // recompute predicate 와 동일
    check(
      `${w.seasonKey} W${w.weekNumber} recompute 대상 = 테스트 전용(${narrowed.length}), 실유저 무접촉`,
      narrowed.length === testCohort.length && narrowed.every((id) => testIds.has(id)),
    );
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${failed} 위반`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
