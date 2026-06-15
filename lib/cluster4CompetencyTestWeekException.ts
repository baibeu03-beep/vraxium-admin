// 실무 역량(practical-competency) 전용 — 테스트 모드 13주차 개설 예외.
// ─────────────────────────────────────────────────────────────────────
// 배경: 2026 봄 시즌은 정규 활동 주차가 13주차까지이고 14~16주차는 공식 휴식이다.
//   휴식 꼬리 구간(오늘이 W14 이후)에서는 금요일 경계 규칙상 개설 대상 주차가 휴식 주차로
//   넘어가, 마지막 활동 주차인 W13 을 더 이상 개설 대상으로 잡지 못한다(운영·테스트 공통).
//
// 정책: 운영 모드는 기존 제한을 그대로 유지한다(휴식 주차 → W13 개설 불가).
//   테스트 모드(mode=test)에서만 검증 목적으로 개설 대상을 "2026 봄 W13" 한 주차로 고정한다.
//
// 적용 범위(엄격): 실무 역량 허브 한정. info/experience/career·weeks-options·시즌/주차 정책
//   공용 함수(cluster4WeekPolicy)는 건드리지 않는다 — 본 예외는 역량 개설 데이터 레이어에서만 호출.
//   또한 "13주차만" 이동한다(다른 활동 주차로는 절대 옮기지 않음).
// ─────────────────────────────────────────────────────────────────────

import { describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import type { ScopeMode } from "@/lib/userScopeShared";

const DAY_MS = 86_400_000;

// 예외가 적용되는 시즌/주차(고정 상수). 2026 봄 시즌의 마지막 활동 주차.
export const COMPETENCY_TEST_WEEK_EXCEPTION = {
  seasonKey: "2026-spring",
  weekNumber: 13,
  // 휴식 꼬리(이 주차 번호 이상)일 때만 W13 으로 고정. 14=첫 공식 휴식 주차.
  restTailFromWeek: 14,
} as const;

// 정규 금요일경계 개설 대상 주차 시작 ms 를 받아, 테스트 모드 예외가 적용되면
// 2026 봄 W13 시작 ms 를, 아니면 null(예외 미적용 = 정규 주차 그대로 사용)을 반환한다.
//
//   · mode !== 'test'                         → null (운영 모드 기존 정책 유지)
//   · 정규 대상이 2026 봄 시즌이 아님          → null (다른 시즌 무관)
//   · 정규 대상 weekNumber < 14(아직 활동 주차) → null (정규 계산이 이미 올바름)
//   · 정규 대상이 2026 봄 W14~(휴식 꼬리/전환) → W13 시작 ms (검증용 고정)
export function resolveCompetencyTestWeekOverrideMs(
  mode: ScopeMode,
  openableWeekStartMs: number | null,
): number | null {
  if (mode !== "test") return null;
  if (openableWeekStartMs == null) return null;

  const info = describeWeekByStartMs(openableWeekStartMs);
  if (!info) return null;
  if (info.seasonKey !== COMPETENCY_TEST_WEEK_EXCEPTION.seasonKey) return null;
  if (info.weekNumber < COMPETENCY_TEST_WEEK_EXCEPTION.restTailFromWeek) return null;

  // 주차는 연속 7일 간격이므로 (현재 weekNumber − 13) 주만큼 뒤로 이동하면 W13 시작.
  const weeksBack = info.weekNumber - COMPETENCY_TEST_WEEK_EXCEPTION.weekNumber;
  return openableWeekStartMs - weeksBack * 7 * DAY_MS;
}
