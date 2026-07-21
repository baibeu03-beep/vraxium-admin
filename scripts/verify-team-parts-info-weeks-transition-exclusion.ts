/**
 * READ-ONLY 검증: /admin/team-parts/info/weeks 에서 전환 주차(다음 시즌 W0)가 제외되는지.
 *
 *   1) API 원본(loadSeasonWeeks)에 전환 주차(여름 W0 등)가 존재하는지
 *   2) 페이지 로더(loadTeamPartsInfoWeeks) 결과에서 전환 주차가 제외되는지 (items / totalCount)
 *   3) 어떤 주차도 week_number===0 또는 전환 월요일로 노출되지 않는지
 *   4) 결과 수(totalCount) == (전체 주차 − 전환 주차) 인지
 *   5) 페이지네이션 totalPages 가 제외 후 값과 정합
 *   6) operating vs test 모드 동일(전환 제외 파리티)
 *   7) 모든 org 동일
 *   8) 전환 기간 훅(today=전환 월요일) 시 currentWeek.isTransitionPeriod=true & 0주차 미노출 & 자동선택 정상
 *
 *   .select 전용. write 없음.
 *   실행: npx tsx --env-file=.env.local scripts/verify-team-parts-info-weeks-transition-exclusion.ts
 */
import { ORGANIZATIONS } from "@/lib/organizations";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function main() {
  console.log("=== 전환 주차 제외 검증 (READ-ONLY, direct) ===\n");

  // ── A. API 원본에 전환 주차가 존재하는가 ─────────────────────────────
  const { rows } = await loadSeasonWeeks();
  const transitionRows = rows.filter((r) => r.is_transition);
  const w0Rows = rows.filter((r) => r.week_number === 0);
  console.log(`[A] loadSeasonWeeks 총 ${rows.length}주차 · 전환 주차 ${transitionRows.length}건`);
  for (const r of transitionRows) {
    console.log(
      `    · ${r.season_key} W${r.week_number} start=${r.week_start_date} ` +
        `(is_official_rest=${r.is_official_rest}, is_current=${r.is_current_week})`,
    );
  }
  check("[A] API 원본에 전환 주차가 최소 1건 존재", transitionRows.length > 0, {
    transition: transitionRows.length,
    week0: w0Rows.length,
  });
  // is_transition SoT 가 week_number===0 을 모두 포함하는지(신규 형태).
  check(
    "[A] week_number===0 은 전부 is_transition=true",
    w0Rows.every((r) => r.is_transition),
    { week0: w0Rows.length },
  );

  const totalWeeks = rows.length;
  const expectedVisible = rows.filter((r) => !r.is_transition).length;

  // ── B. 각 org · 각 모드 로더 결과에서 전환 제외 ──────────────────────
  for (const org of ORGANIZATIONS) {
    for (const mode of ["operating", "test"] as const) {
      // 전 페이지 순회하며 노출 주차 전량 수집.
      const first = await loadTeamPartsInfoWeeks({ organization: org, page: 1, pageSize: 100, mode });
      const totalCount = first.pagination.totalCount;
      const totalPages = first.pagination.totalPages;

      const allItems = [...first.items];
      for (let p = 2; p <= totalPages; p++) {
        const pg = await loadTeamPartsInfoWeeks({ organization: org, page: p, pageSize: 100, mode });
        allItems.push(...pg.items);
      }

      // 노출된 어떤 주차도 전환 주차가 아니어야 한다(주차명에 "- 0" 패턴 + weekId 대조).
      const transitionIds = new Set(transitionRows.map((r) => r.week_id));
      const leakedById = allItems.filter((it) => transitionIds.has(it.weekId));
      // 주차명 문자열로도 0주차 노출 없음(표시 문자열 숨김 회귀 방지).
      const leakedByName = allItems.filter((it) => /(^|\s)-\s*0$/.test(it.weekName.trim()));

      check(`[B:${org}/${mode}] items 에 전환 weekId 누수 0`, leakedById.length === 0,
        leakedById.map((x) => x.weekName));
      check(`[B:${org}/${mode}] items 에 "- 0" 주차명 노출 0`, leakedByName.length === 0,
        leakedByName.map((x) => x.weekName));
      check(`[B:${org}/${mode}] totalCount == 전체−전환(${expectedVisible})`, totalCount === expectedVisible,
        { totalCount, totalWeeks, expectedVisible });
      check(`[B:${org}/${mode}] 수집 items 수 == totalCount`, allItems.length === totalCount,
        { collected: allItems.length, totalCount });
      check(`[B:${org}/${mode}] totalPages 정합`, totalPages === Math.max(1, Math.ceil(expectedVisible / 100)),
        { totalPages, expectedVisible });
    }
  }

  // ── C. operating vs test 파리티(구조: 노출 주차 집합 동일) ────────────
  {
    const opWeeks = new Set(
      (await loadTeamPartsInfoWeeks({ organization: ORGANIZATIONS[0], page: 1, pageSize: 100, mode: "operating" }))
        .items.map((i) => i.weekId),
    );
    const testWeeks = new Set(
      (await loadTeamPartsInfoWeeks({ organization: ORGANIZATIONS[0], page: 1, pageSize: 100, mode: "test" }))
        .items.map((i) => i.weekId),
    );
    const sameSet = opWeeks.size === testWeeks.size && [...opWeeks].every((w) => testWeeks.has(w));
    check(`[C] operating/test 노출 주차 집합 동일(${ORGANIZATIONS[0]})`, sameSet,
      { op: opWeeks.size, test: testWeeks.size });
  }

  // ── D. 전환 기간 훅(today=전환 월요일)에서 자동선택/안내 ──────────────
  //   가장 최근 전환 주차의 시작일을 오늘로 고정 → currentWeek 가 전환 기간으로 인식되는지.
  {
    const anyTransition = [...transitionRows]
      .filter((r) => r.week_start_date)
      .sort((a, b) => (a.week_start_date! < b.week_start_date! ? 1 : -1))[0];
    if (!anyTransition?.week_start_date) {
      check("[D] 전환 주차 시작일 확보", false);
    } else {
      const today = anyTransition.week_start_date;
      check("[D] today 는 전환 월요일", isTransitionWeekStart(today), { today });
      const res = await loadTeamPartsInfoWeeks({
        organization: ORGANIZATIONS[0], page: 1, pageSize: 100, mode: "operating", today,
      });
      check("[D] currentWeek.isTransitionPeriod=true", res.currentWeek.isTransitionPeriod === true,
        res.currentWeek);
      check("[D] 전환 기간 배너 주차명 null(0주차 자동선택 안함)",
        res.currentWeek.seasonWeekName === null, res.currentWeek);
      check("[D] 전환 기간 배너 활동상태 null(공식활동 오분류 없음)",
        res.currentWeek.clubActivityStatus === null, res.currentWeek);
      // 전환 제외 후에도 목록이 비지 않고(선택값 존재) 0주차 미노출.
      check("[D] 전환 제외 후 목록 비어있지 않음", res.items.length > 0, { items: res.items.length });
      const transIds = new Set(transitionRows.map((t) => t.week_id));
      check("[D] 목록에 전환 주차 없음", res.items.every((it) => !transIds.has(it.weekId)));
    }
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
