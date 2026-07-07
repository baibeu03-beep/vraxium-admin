/**
 * 라인 강화 상태 수동 override 검증 (2026-07-07).
 *
 *   npx tsx --env-file=.env.local scripts/verify-enhancement-override.ts
 *
 * Part A (DB 불필요): 재파생 정합 — override 로 라인 enhancementStatus 를 바꾼 뒤
 *   breakdownFromLines + attachLineBreakdown 로 재산출한 라인 numerator/denominator 가
 *   카드 성장률(성공/분모)과 항상 일치하는지 순수 함수로 확인한다.
 *
 * Part B (DB 있으면): 실제 사용자 raw snapshot 에 대해
 *   ① override 없음 → applyEnhancementOverridesToCards 가 입력과 동일 참조 반환(100% 동일)
 *   ② override 삽입 → 해당 라인만 enhancementStatus 가 바뀌고 카드 수치가 정합
 *   ③ override 삭제 → 자동 계산값 복귀
 *   (테이블 미적용/env 부재면 Part B 는 SKIP.)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  breakdownFromLines,
  attachLineBreakdown,
  emptyBreakdown,
} from "../lib/cluster4WeeklyCardsData";
import { roundGrowthRate } from "../lib/lineAvailability";
import type {
  Cluster4LineDetailDto,
  Cluster4EnhancementStatus,
} from "../shared/cluster4.contracts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error("  ✗", msg);
  } else {
    console.log("  ✓", msg);
  }
}

// 최소 라인 DTO 스텁 (재파생에 쓰이는 필드만 채운다).
function line(
  partType: Cluster4LineDetailDto["partType"],
  status: Cluster4EnhancementStatus,
  extra: Partial<Cluster4LineDetailDto> = {},
): Cluster4LineDetailDto {
  return {
    partType,
    enhancementStatus: status,
    // 재파생에서 참조하는 필드 외에는 최소값으로 채운다.
    activityTypeKey: null,
    activityTypeId: null,
    numerator: null,
    denominator: null,
    rate: null,
    // 타입 만족용 나머지 필드(재파생 로직 미참조).
  } as unknown as Cluster4LineDetailDto;
}

// 카드 성장률 재산출 (cluster4EnhancementOverride.ts 와 동일 산식) → 라인 breakdown 과 정합 확인.
function deriveAndCheck(
  label: string,
  lines: Cluster4LineDetailDto[],
  rest: boolean,
) {
  const breakdown = rest ? emptyBreakdown() : breakdownFromLines(lines);
  const completed =
    breakdown.info.completed +
    breakdown.ability.completed +
    breakdown.experience.completed +
    breakdown.career.completed;
  const available =
    breakdown.info.available +
    breakdown.ability.available +
    breakdown.experience.available +
    breakdown.career.available;
  const withBd = attachLineBreakdown(lines, breakdown, rest);

  // 각 파트별로: 그 파트 라인들의 denominator 는 hub available 과 동일해야 한다.
  const partAvail: Record<string, number> = {
    information: breakdown.info.available,
    competency: breakdown.ability.available,
    experience: breakdown.experience.available,
    career: breakdown.career.available,
  };
  const partDone: Record<string, number> = {
    information: breakdown.info.completed,
    competency: breakdown.ability.completed,
    experience: breakdown.experience.completed,
    career: breakdown.career.completed,
  };
  let ok = true;
  for (const l of withBd) {
    const av = partAvail[l.partType] ?? 0;
    if (rest || av <= 0) {
      if (l.numerator !== null || l.denominator !== null || l.rate !== null) ok = false;
    } else {
      if (l.denominator !== av) ok = false;
      if (l.numerator !== partDone[l.partType]) ok = false;
    }
  }
  assert(ok, `${label}: 라인 numerator/denominator 가 hub breakdown 과 일치`);
  const cardRate = roundGrowthRate(completed, available);
  console.log(
    `      → completed=${completed} available=${available} rate=${cardRate}% ` +
      `(exp ${breakdown.experience.completed}/${breakdown.experience.available})`,
  );
  return { completed, available, cardRate };
}

async function partA() {
  console.log("[Part A] 재파생 정합 (순수 함수)");
  // 기본: info(success), competency(fail), experience(success), career(pending)
  const base = [
    line("information", "success"),
    line("competency", "fail"),
    line("experience", "success"),
    line("career", "pending"),
  ];
  const before = deriveAndCheck("기본", base, false);
  assert(before.available === 4 && before.completed === 2, "기본: 2/4");

  // override: competency fail → success (성공 1 증가)
  const overridden = base.map((l, i) =>
    i === 1 ? { ...l, enhancementStatus: "success" as const } : l,
  );
  const after = deriveAndCheck("override(competency fail→success)", overridden, false);
  assert(
    after.completed === before.completed + 1 && after.available === before.available,
    "override 후 성공 +1, 분모 불변 (3/4)",
  );

  // override: experience success → not_applicable (분모 제외 → available 감소)
  const naOverride = base.map((l, i) =>
    i === 2 ? { ...l, enhancementStatus: "not_applicable" as const } : l,
  );
  const na = deriveAndCheck("override(experience success→na)", naOverride, false);
  assert(
    na.available === before.available - 1 && na.completed === before.completed - 1,
    "not_applicable override 는 분모·분자에서 제외 (1/3)",
  );

  // 휴식 주차: 전부 null
  deriveAndCheck("휴식주차(rest)", base, true);
}

async function partB() {
  console.log("\n[Part B] 실제 DB end-to-end");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("  · SKIP (env 없음)");
    return;
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);

  // 테이블 존재 확인.
  const probe = await supabase
    .from("cluster4_line_enhancement_overrides")
    .select("id")
    .limit(1);
  if (probe.error) {
    console.log(
      "  · SKIP (테이블 미적용 — 마이그레이션 적용 후 재실행):",
      probe.error.message,
    );
    return;
  }
  // line_ordinal 컬럼 확인(1차 버전 테이블에는 없음 → 마이그레이션 재적용 필요).
  const probeOrdinal = await supabase
    .from("cluster4_line_enhancement_overrides")
    .select("line_ordinal")
    .limit(1);
  if (probeOrdinal.error) {
    console.log(
      "  · SKIP (line_ordinal 컬럼 없음 — 갱신된 마이그레이션 재적용 후 재실행):",
      probeOrdinal.error.message,
    );
    return;
  }

  const { applyEnhancementOverridesToCards } = await import(
    "../lib/cluster4EnhancementOverride"
  );
  const { readWeeklyCardsSnapshot } = await import(
    "../lib/cluster4WeeklyCardsSnapshot"
  );

  // 라인이 있는 사용자 하나를 찾는다.
  const { data: snaps } = await supabase
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .limit(50);
  let target: { userId: string; card: any; line: any } | null = null;
  for (const row of snaps ?? []) {
    const uid = (row as any).user_id as string;
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    for (const card of snap.cards) {
      if (!card.weekId || !Array.isArray(card.lines)) continue;
      const l = card.lines.find(
        (x: any) => x.lineTargetId || x.lineId || x.lineCode,
      );
      if (l) {
        target = { userId: uid, card, line: l };
        break;
      }
    }
    if (target) break;
  }
  if (!target) {
    console.log("  · SKIP (식별 가능한 라인 보유 사용자 없음)");
    return;
  }
  const { userId, card, line: L } = target;
  console.log(`  · 대상 user=${userId} week=${card.weekId} part=${L.partType} auto=${L.enhancementStatus}`);

  // ① override 없음 → 동일 참조
  const snap0 = await readWeeklyCardsSnapshot(userId);
  const raw0 = (snap0 as any).cards;
  const out0 = await applyEnhancementOverridesToCards(userId, raw0);
  assert(out0 === raw0, "① override 없음 → 입력과 동일 참조(100% 동일)");

  // ② override 삽입 (auto 와 다른 값 선택)
  const flipTo: Cluster4EnhancementStatus =
    L.enhancementStatus === "success" ? "fail" : "success";
  const ins = await supabase
    .from("cluster4_line_enhancement_overrides")
    .insert({
      user_id: userId,
      week_id: card.weekId,
      part_type: L.partType,
      line_target_id: L.lineTargetId ?? null,
      line_id: L.lineId ?? null,
      line_code: L.lineCode ?? null,
      override_status: flipTo,
      source: "verify_script",
      note: "verify-enhancement-override.ts",
    })
    .select("id")
    .maybeSingle();
  if (ins.error) {
    console.error("  ✗ override insert 실패:", ins.error.message);
    failures++;
    return;
  }
  const overrideId = (ins.data as any).id as string;

  try {
    const out1 = await applyEnhancementOverridesToCards(userId, raw0);
    assert(out1 !== raw0, "② override 있음 → 새 배열(참조 다름)");
    const card1 = out1.find((c) => c.weekId === card.weekId)!;
    const l1 = card1.lines.find(
      (x) =>
        (L.lineTargetId && x.lineTargetId === L.lineTargetId) ||
        (!L.lineTargetId && L.lineId && x.lineId === L.lineId) ||
        (!L.lineTargetId && !L.lineId && L.lineCode && x.lineCode === L.lineCode),
    )!;
    assert(l1.enhancementStatus === flipTo, `② 해당 라인 enhancementStatus=${flipTo} 로 변경`);

    // 정합: 카드의 growthNumerator = 재파생 breakdown 성공 수
    const rest = card1.isRestWeek;
    const bd = rest ? emptyBreakdown() : breakdownFromLines(card1.lines);
    const comp =
      bd.info.completed + bd.ability.completed + bd.experience.completed + bd.career.completed;
    const avail =
      bd.info.available + bd.ability.available + bd.experience.available + bd.career.available;
    assert(
      card1.growthNumerator === comp && card1.growthDenominator === avail,
      `② 카드 growthNumerator/Denominator(${card1.growthNumerator}/${card1.growthDenominator}) = 라인 재파생(${comp}/${avail})`,
    );
    assert(
      card1.weeklyGrowthRate === roundGrowthRate(comp, avail),
      "② 카드 weeklyGrowthRate 가 재파생 rate 와 일치",
    );
    assert(
      card1.experienceRate.count === bd.experience.completed &&
        card1.experienceRate.total === bd.experience.available,
      "② experienceRate 가 experience breakdown 과 일치",
    );
  } finally {
    // ③ 삭제 → 복귀
    await supabase
      .from("cluster4_line_enhancement_overrides")
      .delete()
      .eq("id", overrideId);
    const out2 = await applyEnhancementOverridesToCards(userId, raw0);
    assert(out2 === raw0, "③ override 삭제 후 → 다시 동일 참조(자동 복귀)");
  }
}

async function main() {
  await partA();
  await partB();
  console.log(failures === 0 ? "\nPASS ✅" : `\nFAIL ❌ (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
