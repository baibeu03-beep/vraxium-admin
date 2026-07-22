/**
 * 주차 결과(크루) — direct 검증.
 *
 *   [1] 순수 판정 함수(resolveCrewWeeklyLifecycle) — 시간만 다르게 주입해 3상태 재현 + 데이터 우선
 *       규칙(published 는 날짜 무관 완료 / 미published 는 날짜가 지나도 완료 승격 없음).
 *   [2] SoT 대조 — getCrewWeeklyResultsBundle 의 각 셀이 cluster4_week_org_result_states
 *       (+ 레거시 폴백 weeks.result_reviewed_at) 원본과 일치하는가. 화면 상태를 독자 계산하지 않는가.
 *   [3] 통합 == 클럽 상세 파리티 — 같은 (주차 × 조직) 셀이 두 스코프에서 완전히 동일한가.
 *   [4] operating vs test — DTO 키 구조가 동일한가(값은 scope 별로 다를 수 있음).
 *   [5] 활동 유형 SoT — activityKind 가 weeks.is_official_rest ∪ official_rest_periods 판정과 일치.
 *
 *   읽기 전용 — DB 를 전혀 수정하지 않는다.
 *   Usage: npx tsx --env-file=.env.local scripts/verify-crew-week-results.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  getCrewWeeklyResultsBundle,
  resolveCrewWeeklyLifecycle,
  toCrewWeeklyDisplayStatus,
  crewWeeklyCellKey,
  type CrewWeeklyResultCellDto,
} from "@/lib/crewWeeklyResultProjection";
import {
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
} from "@/lib/weekOrgResultState";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

let fail = 0;
const ck = (cond: boolean, label: string, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};

// 셀 비교 — 실행 컨텍스트가 아니라 "사실"만 비교한다.
function cellFacts(c: CrewWeeklyResultCellDto) {
  return JSON.stringify({
    organizationId: c.organizationId,
    weekId: c.weekId,
    activityKind: c.activityKind,
    lifecycleStatus: c.lifecycleStatus,
    displayStatus: c.displayStatus,
    reviewStatus: c.reviewStatus,
    reviewStatusSource: c.reviewStatusSource,
    openConfirmed: c.openConfirmed,
    isManuallyCompleted: c.isManuallyCompleted,
    completedAt: c.completedAt,
    publishedAt: c.publishedAt,
    resultVersion: c.resultVersion,
    canCompleteManually: c.canCompleteManually,
    criterionPointA: c.criterionPointA,
    criterionMinPointsA: c.criterionMinPointsA,
    criterionExecPointsB: c.criterionExecPointsB,
    memberCount: c.memberCount,
    seasonRestCount: c.seasonRestCount,
    personalRestCount: c.personalRestCount,
    growthChallengeCount: c.growthChallengeCount,
    growthSuccessCount: c.growthSuccessCount,
    growthFailureCount: c.growthFailureCount,
    growthSuccessRatePercent: c.growthSuccessRatePercent,
    growthChallengeRatePercent: c.growthChallengeRatePercent,
  });
}

async function main() {
  // ── [1] 순수 판정 — 시간 주입 3상태 재현 ────────────────────────────────
  console.log("\n[1] 상태 판정(resolveCrewWeeklyLifecycle) — 시간 주입 재현");
  {
    // 주차 진행 중(집계 창 닫힘) → 진행 중.
    const a = resolveCrewWeeklyLifecycle({
      orgStatus: "aggregating",
      aggregationWindowOpen: false,
      weekEnded: false,
      globallyPublished: false,
    });
    ck(a === "activity_in_progress", "활동 기간 중 = activity_in_progress", a);
    ck(toCrewWeeklyDisplayStatus(a) === "in_progress", "표시 = 진행 중");

    // 집계 창 열림 · 미공표 → 집계 대기(집계 중).
    const b = resolveCrewWeeklyLifecycle({
      orgStatus: "aggregating",
      aggregationWindowOpen: true,
      weekEnded: false,
      globallyPublished: false,
    });
    ck(b === "aggregation_pending", "집계 창 열림 = aggregation_pending", b);
    ck(toCrewWeeklyDisplayStatus(b) === "aggregating", "표시 = 집계 중");

    // 전역 공표됐지만 조직 검수 미완 → 검수 대기(여전히 집계 중 표시).
    const c = resolveCrewWeeklyLifecycle({
      orgStatus: "aggregating",
      aggregationWindowOpen: true,
      weekEnded: true,
      globallyPublished: true,
    });
    ck(c === "review_pending", "전역 공표 + 조직 미검수 = review_pending", c);
    ck(toCrewWeeklyDisplayStatus(c) === "aggregating", "표시 = 집계 중");

    // 검수 파이프라인 실행 중 → 집계 중.
    const d = resolveCrewWeeklyLifecycle({
      orgStatus: "reviewing",
      aggregationWindowOpen: true,
      weekEnded: true,
      globallyPublished: false,
    });
    ck(d === "aggregation_in_progress", "reviewing = aggregation_in_progress", d);
    ck(toCrewWeeklyDisplayStatus(d) === "aggregating", "표시 = 집계 중");

    // 조직 published → 날짜와 무관하게 완료(주차가 아직 안 끝났어도).
    const e = resolveCrewWeeklyLifecycle({
      orgStatus: "published",
      aggregationWindowOpen: false,
      weekEnded: false,
      globallyPublished: false,
    });
    ck(e === "review_completed", "published = review_completed (날짜 무관)", e);
    ck(toCrewWeeklyDisplayStatus(e) === "completed", "표시 = 검수 완료");

    // ⚠ 핵심 불변식 — 시간이 아무리 지나도 미published 는 완료가 되지 않는다.
    const f = resolveCrewWeeklyLifecycle({
      orgStatus: "aggregating",
      aggregationWindowOpen: true,
      weekEnded: true,
      globallyPublished: true,
    });
    ck(
      toCrewWeeklyDisplayStatus(f) !== "completed",
      "다음 주가 지나도 미검수는 '검수 완료'로 승격되지 않음",
      f,
    );
  }

  // ── [2] SoT 대조 ────────────────────────────────────────────────────────
  console.log("\n[2] SoT 대조 — 셀 상태 == cluster4_week_org_result_states");
  const bundle = await getCrewWeeklyResultsBundle({
    organizations: [...ORGANIZATIONS],
    mode: "operating",
    page: 1,
    pageSize: 12,
  });
  ck(bundle.weeks.length > 0, "주차 행 로드", `${bundle.weeks.length}주차`);
  ck(
    bundle.organizations.length === ORGANIZATIONS.length,
    "조직 열 = 3개",
    bundle.organizations.map((o) => o.organizationSlug).join(","),
  );
  ck(
    bundle.cells.length === bundle.weeks.length * bundle.organizations.length,
    "셀 개수 = 주차 × 조직",
    `${bundle.cells.length}`,
  );

  {
    const weekIds = bundle.weeks.map((w) => w.weekId);
    const scope = resolveOrgResultScope("operating");
    const { data: legacyRows } = await supabaseAdmin
      .from("weeks")
      .select("id,result_reviewed_at,result_published_at")
      .in("id", weekIds);
    const legacy = new Map(
      (legacyRows ?? []).map((r: { id: string; result_reviewed_at: string | null; result_published_at: string | null }) => [
        r.id,
        r,
      ]),
    );

    let mismatches = 0;
    let publishedSeen = 0;
    for (const org of ORGANIZATIONS) {
      const states = await loadWeekOrgResultStates(weekIds, org, scope);
      for (const week of bundle.weeks) {
        const expected = resolveWeekOrgResultState(
          states.get(week.weekId),
          week.startDate ?? "",
          legacy.get(week.weekId)?.result_reviewed_at != null,
        );
        const cell = bundle.cells.find(
          (c) => crewWeeklyCellKey(c.weekId, c.organizationSlug) === crewWeeklyCellKey(week.weekId, org),
        );
        if (!cell) {
          mismatches++;
          continue;
        }
        if (cell.reviewStatus !== expected.status) mismatches++;
        if (cell.publishedAt !== (legacy.get(week.weekId)?.result_published_at ?? null)) {
          mismatches++;
        }
        // 완료 표시는 오직 published 에서만 나온다.
        if ((cell.displayStatus === "completed") !== (expected.status === "published")) {
          mismatches++;
        }
        if (expected.status === "published") publishedSeen++;
      }
    }
    ck(mismatches === 0, "모든 셀의 reviewStatus/publishedAt/완료여부가 SoT 와 일치", `불일치 ${mismatches}`);
    console.log(`    (참고) published 셀 ${publishedSeen}개`);
  }

  // ── [3] 통합 == 클럽 상세 파리티 ────────────────────────────────────────
  console.log("\n[3] 통합 목록 == 클럽 상세 파리티");
  for (const org of ORGANIZATIONS) {
    const detail = await getCrewWeeklyResultsBundle({
      organizations: [org],
      mode: "operating",
      page: 1,
      pageSize: 12,
    });
    ck(
      detail.organizations.length === 1 && detail.organizations[0].organizationSlug === org,
      `${org}: 상세는 조직 1개만`,
    );
    ck(
      JSON.stringify(detail.weeks) === JSON.stringify(bundle.weeks),
      `${org}: 주차 행(DTO) 동일`,
    );
    const integratedCells = bundle.cells
      .filter((c) => c.organizationSlug === org)
      .map(cellFacts);
    const detailCells = detail.cells.map(cellFacts);
    ck(
      JSON.stringify(integratedCells) === JSON.stringify(detailCells),
      `${org}: 셀 값 완전 동일(통합 == 상세)`,
      `${detailCells.length}셀`,
    );
  }

  // ── [4] operating vs test — DTO 키 구조 동일 ────────────────────────────
  console.log("\n[4] 일반 모드 vs mode=test — DTO 키 파리티");
  {
    const testBundle = await getCrewWeeklyResultsBundle({
      organizations: [...ORGANIZATIONS],
      mode: "test",
      page: 1,
      pageSize: 12,
    });
    ck(
      JSON.stringify(Object.keys(bundle).sort()) ===
        JSON.stringify(Object.keys(testBundle).sort()),
      "번들 최상위 키 동일",
    );
    ck(
      JSON.stringify(Object.keys(bundle.cells[0] ?? {}).sort()) ===
        JSON.stringify(Object.keys(testBundle.cells[0] ?? {}).sort()),
      "셀 DTO 키 동일",
    );
    ck(
      JSON.stringify(Object.keys(bundle.weeks[0] ?? {}).sort()) ===
        JSON.stringify(Object.keys(testBundle.weeks[0] ?? {}).sort()),
      "주차 DTO 키 동일",
    );
    // 주차/조직/활동유형은 모집단과 무관 → 값까지 동일해야 한다.
    ck(
      JSON.stringify(bundle.weeks) === JSON.stringify(testBundle.weeks),
      "주차 행 값 동일(mode 불변)",
    );
    ck(bundle.scope === "operating" || bundle.scope === "test", "scope 노출됨", bundle.scope);
    ck(testBundle.scope === "test", "mode=test → scope=test", testBundle.scope);
  }

  // ── [5] 활동 유형 SoT ───────────────────────────────────────────────────
  console.log("\n[5] 활동 유형 == loadSeasonWeeks(is_official_rest)");
  {
    const { rows } = await loadSeasonWeeks();
    const byId = new Map(rows.map((r) => [r.week_id, r]));
    let bad = 0;
    for (const w of bundle.weeks) {
      const src = byId.get(w.weekId);
      if (!src) {
        bad++;
        continue;
      }
      const expected = src.is_official_rest ? "official_rest" : "official_activity";
      if (w.activityKind !== expected) bad++;
      // 셀 미러도 같은 값이어야 한다.
      for (const c of bundle.cells.filter((c) => c.weekId === w.weekId)) {
        if (c.activityKind !== expected) bad++;
      }
    }
    ck(bad === 0, "주차/셀 activityKind 가 주차 SoT 와 일치", `불일치 ${bad}`);
    // 전환 주차는 데이터셋에서 제외됐는가.
    const transitionLeak = bundle.weeks.filter((w) => byId.get(w.weekId)?.is_transition).length;
    ck(transitionLeak === 0, "전환 주차 제외됨", `누출 ${transitionLeak}`);
  }

  // ── [6] 미래 주차 비노출 ────────────────────────────────────────────────
  console.log("\n[6] 미래 주차는 결과 화면에 노출되지 않는다");
  {
    const today = getCurrentActivityDateIso();
    const leaked = bundle.weeks.filter((w) => (w.startDate ?? "") > today);
    ck(leaked.length === 0, "오늘 기준 미래 주차 누출 0", leaked.map((w) => w.tableName).join(","));
    const scheduled = bundle.cells.filter((c) => c.lifecycleStatus === "scheduled");
    ck(scheduled.length === 0, "노출 셀에 scheduled 없음", `${scheduled.length}`);

    // 순수 함수 방어 — 미래 주차는 어떤 조합에서도 진행 중으로 해석되지 않는다.
    const s1 = resolveCrewWeeklyLifecycle({
      orgStatus: "aggregating", notStarted: true,
      aggregationWindowOpen: false, weekEnded: false, globallyPublished: false,
    });
    ck(s1 === "scheduled", "notStarted → scheduled (진행 중 아님)", s1);
    const s2 = resolveCrewWeeklyLifecycle({
      orgStatus: "published", notStarted: true,
      aggregationWindowOpen: true, weekEnded: true, globallyPublished: true,
    });
    ck(s2 === "scheduled", "notStarted 는 published 보다 우선", s2);

    // today 주입 재현 — 과거 시점에서는 그 시점의 현재 주차까지만 나온다.
    const past = await getCrewWeeklyResultsBundle({
      organizations: [...ORGANIZATIONS], mode: "operating", page: 1, pageSize: 3,
      today: "2026-06-01",
    });
    const pastLeak = past.weeks.filter((w) => (w.startDate ?? "") > "2026-06-01");
    ck(pastLeak.length === 0, "today 주입 시 그 시점 기준으로 잘림", `누출 ${pastLeak.length}`);
    ck(
      past.pagination.totalCount < bundle.pagination.totalCount,
      "과거 today 는 총 주차수가 더 적다",
      `${past.pagination.totalCount} < ${bundle.pagination.totalCount}`,
    );
  }

  // ── [7] scope 통일 + 미확정 마스킹 ────────────────────────────────────
  console.log("");
  console.log("[7] scope 통일 · 미확정 주차 마스킹");
  {
    const METRIC_KEYS = [
      "memberCount", "seasonRestCount", "personalRestCount", "growthChallengeCount",
      "growthSuccessCount", "growthFailureCount", "growthSuccessRatePercent",
      "growthChallengeRatePercent",
    ] as const;

    for (const m of ["operating", "test"] as const) {
      const bd = await getCrewWeeklyResultsBundle({
        organizations: [...ORGANIZATIONS], mode: m, page: 1, pageSize: 20,
      });
      // 상태 scope == 지표 scope (단일 출처) — QA_HIDE_REAL_USERS 반영값과 일치해야 한다.
      ck(bd.scope === resolveOrgResultScope(m), `${m}: 번들 scope == resolveOrgResultScope`, bd.scope);
      ck(bd.populationSize > 0, `${m}: 지표 모집단 노출`, `${bd.populationSize}명`);

      // 미확정 주차 = 결과 지표 전부 null(N). 기준 포인트 A 는 결과가 아니므로 마스킹 대상 아님.
      const unconfirmed = bd.cells.filter(
        (c) => c.displayStatus !== "completed" && c.activityKind !== "official_rest",
      );
      const leaked = unconfirmed.filter((c) =>
        METRIC_KEYS.some((k) => (c as unknown as Record<string, unknown>)[k] !== null),
      );
      ck(leaked.length === 0, `${m}: 미확정 주차 결과 지표 전부 N`, `누출 ${leaked.length}/${unconfirmed.length}`);
      ck(
        unconfirmed.every((c) => c.metricsAvailable === false),
        `${m}: 미확정 주차 metricsAvailable=false`,
      );
      // 기준 포인트 A 는 미확정 주차에도 남는다(값이 있는 셀이 존재해야 규칙이 의미 있다).
      const withA = unconfirmed.filter((c) => c.criterionPointA != null);
      ck(withA.length > 0, `${m}: 미확정 주차에도 기준 포인트 A 표시`, `${withA.length}셀`);

      // 검수 완료 주차 = **공표 snapshot 이 있을 때만** 확정 숫자 노출.
      //   legacy 공표본(snapshot 미보유)은 live 로 폴백하지 않고 마스킹한다(조용한 오염 방지).
      const done = bd.cells.filter(
        (c) => c.displayStatus === "completed" && c.activityKind !== "official_rest",
      );
      const withSnapshot = done.filter((c) => c.publishedRunId != null);
      const legacyDone = done.filter((c) => c.publishedRunId == null);
      ck(
        withSnapshot.every((c) => c.memberCount !== null && c.metricsAvailable),
        `${m}: 공표 snapshot 있는 검수 완료 = 숫자 표시`,
        `${withSnapshot.length}셀`,
      );
      ck(
        legacyDone.every((c) => c.memberCount === null && !c.metricsAvailable),
        `${m}: snapshot 없는 공표본 = 마스킹(live 폴백 금지)`,
        `${legacyDone.length}셀`,
      );
      // 공식 휴식 주차는 하드 0(마스킹 아님).
      const rest = bd.cells.filter((c) => c.activityKind === "official_rest");
      ck(
        rest.every((c) => c.memberCount === 0 && c.growthChallengeCount === 0),
        `${m}: 공식 휴식 주차 = 하드 0`,
        `${rest.length}셀`,
      );
    }
  }

  console.log(
    `\n${fail === 0 ? "PASS" : "FAIL"} — 실패 ${fail}건`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
