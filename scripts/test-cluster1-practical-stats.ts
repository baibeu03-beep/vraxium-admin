import assert from "node:assert/strict";
import {
  aggregateConfirmedPracticalSuccesses,
  breakdownFromLines,
} from "../lib/cluster4WeeklyCardsData";
import { applyEnhancementOverridesToCards } from "../lib/cluster4EnhancementOverride";
import type {
  Cluster4LineDetailDto,
  Cluster4WeeklyCardDto,
} from "../shared/cluster4.contracts";

function line(
  partType: Cluster4LineDetailDto["partType"],
  enhancementStatus: Cluster4LineDetailDto["enhancementStatus"],
  extra: Partial<Cluster4LineDetailDto> = {},
): Cluster4LineDetailDto {
  return {
    partType,
    enhancementStatus,
    lineId: null,
    lineTargetId: null,
    lineCode: null,
    activityTypeId: null,
    activityTypeKey: null,
    experienceCategory: null,
    experienceSlotOrder: null,
    ...extra,
  } as Cluster4LineDetailDto;
}

function card(
  weekId: string,
  lines: Cluster4LineDetailDto[],
  extra: Partial<Cluster4WeeklyCardDto> = {},
): Cluster4WeeklyCardDto {
  return {
    weekId,
    userWeekStatus: "success",
    isTransition: false,
    isRestWeek: false,
    lines,
    ...extra,
  } as Cluster4WeeklyCardDto;
}

async function main() {
  const confirmed = card("published", [
    // 같은 정보 유형의 복수 라인은 공통 규칙으로 1개만 성공 집계.
    line("information", "success", {
      lineId: "info-1",
      activityTypeKey: "wisdom",
    }),
    line("information", "success", {
      lineId: "info-2",
      activityTypeKey: "wisdom",
    }),
    // 같은 주차의 복수 경험 유형 슬롯 성공은 슬롯별로 각각 집계.
    line("experience", "success", {
      lineId: "exp-derive",
      lineTargetId: "target-exp-derive",
      experienceSlotOrder: 1,
    }),
    line("experience", "success", {
      lineId: "exp-analysis",
      lineTargetId: "target-exp-analysis",
      experienceSlotOrder: 2,
    }),
    // 복수 경력 프로젝트 성공도 프로젝트·슬롯별로 각각 집계.
    line("career", "success", {
      lineId: "career-1",
      lineTargetId: "target-career-1",
    }),
    line("career", "success", {
      lineId: "career-2",
      lineTargetId: "target-career-2",
    }),
    // 역량 대상자 성공 1개와 비대상 실패 placeholder.
    line("competency", "success", {
      lineId: "comp-1",
      lineTargetId: "target-comp-1",
    }),
    line("competency", "fail"),
  ]);

  const excluded = [
    card(
      "running",
      [line("information", "success", { activityTypeKey: "essay" })],
      {
        userWeekStatus: "running",
      },
    ),
    card("rest", [line("career", "success", { lineId: "career-rest" })], {
      isRestWeek: true,
      userWeekStatus: "official_rest",
    }),
    card(
      "transition",
      [line("experience", "success", { experienceSlotOrder: 3 })],
      {
        isTransition: true,
      },
    ),
  ];

  const common = breakdownFromLines(confirmed.lines);
  const totals = aggregateConfirmedPracticalSuccesses([confirmed, ...excluded]);
  assert.deepEqual(totals, {
    infoCount: common.info.completed,
    experienceCount: common.experience.completed,
    abilityUnitCount: common.ability.completed,
    careerProjectCount: common.career.completed,
  });
  assert.deepEqual(totals, {
    infoCount: 1,
    experienceCount: 2,
    abilityUnitCount: 1,
    careerProjectCount: 2,
  });

  const overrideBase = card("override-week", [
    line("information", "fail", {
      lineId: "override-info",
      lineTargetId: "override-target",
      activityTypeKey: "forum",
    }),
  ]);
  const overrideRow = {
    id: "override-id",
    user_id: "user-1",
    week_id: "override-week",
    part_type: "information",
    line_target_id: "override-target",
    line_id: "override-info",
    line_code: null,
    line_ordinal: null,
    override_status: "success" as const,
    source: "admin_manual",
    note: null,
    created_by: null,
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
  };
  const successOverrideCards = await applyEnhancementOverridesToCards(
    "user-1",
    [overrideBase],
    Promise.resolve([overrideRow]),
  );
  assert.equal(
    aggregateConfirmedPracticalSuccesses(successOverrideCards).infoCount,
    1,
  );

  const failedOverrideCards = await applyEnhancementOverridesToCards(
    "user-1",
    successOverrideCards,
    Promise.resolve([{ ...overrideRow, override_status: "fail" as const }]),
  );
  assert.equal(
    aggregateConfirmedPracticalSuccesses(failedOverrideCards).infoCount,
    0,
  );

  // mode는 사용자 선택에만 관여한다. 집계 함수에는 mode 분기가 없다.
  assert.deepEqual(
    aggregateConfirmedPracticalSuccesses([confirmed]),
    aggregateConfirmedPracticalSuccesses([confirmed]),
  );

  console.log("cluster1 practical stats tests: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
