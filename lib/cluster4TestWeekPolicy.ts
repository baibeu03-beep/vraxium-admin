// Cluster4 주차 정책 어댑터 (browser-safe · DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 【2026-07-01 정책 변경】"테스트 모드 휴식꼬리 W13 예외"는 폐지됐다.
//   운영과 QA는 같은 로직을 쓴다 — 주차/시즌/개설 대상 주차는 항상 operating(금요일 경계 규칙)
//   기준이며, "테스트 전용 주차 정책(W13 되돌리기)"으로 분기하지 않는다. QA 기간의 유일한 차이는
//   "사람 모집단(lib/qaFixedScope.QA_HIDE_REAL_USERS)"뿐이고, 주차 축은 그 스위치와 무관하다.
//
// 이 모듈은 개설/체크/적립/드롭다운 호출부의 시그니처 호환을 위해 남겨둔 얇은 pass-through 다.
//   resolveCluster4TestOpenableWeekStartMs 는 이제 항상 base(정규 대상 주차)를 그대로 반환한다.
//   (예외 판정 함수는 항상 false — 테스트 예외 경로 진입 자체가 없다.)
//
// ⚠ 신규 코드는 이 모듈을 호출할 필요가 없다(정규 주차 계산을 직접 쓰면 된다). 남은 호출부는
//   점진적으로 제거 예정 — 새 test-week 예외를 여기에 다시 추가하지 말 것.
// ─────────────────────────────────────────────────────────────────────────────

import type { ScopeMode } from "@/lib/userScopeShared";

// (참조용) 과거 테스트 예외가 적용됐던 (시즌, 마지막 활동 주차) — 폐지됨. 하드코딩 산재 방지용 기록만 유지.
export const CLUSTER4_TEST_EXCEPTION_WEEKS: ReadonlyArray<{
  seasonKey: string;
  weekNumber: number;
}> = [];

// 개설/체크 호출부 hub 식별자(시그니처 호환용 — 동작에는 더 이상 영향 없음).
export type Cluster4TestWeekHub =
  | "info-line"
  | "experience-line"
  | "competency-line"
  | "career-line"
  | "process-club"
  | "process-info"
  | "process-experience"
  | "process-competency"
  | "process-career"
  | "process-irregular"
  | "accrual"
  | "dropdown";

// 폐지된 예외 판정 — 항상 false(테스트 전용 주차 정책 없음).
export function isCluster4TestExceptionWeek(
  _mode: ScopeMode,
  _seasonKey: string | null,
  _weekNumber: number | null,
): boolean {
  return false;
}

// 폐지된 예외 허용 판정 — 항상 false.
export function isTestWeekExceptionAllowed(
  _mode: ScopeMode,
  _hub: Cluster4TestWeekHub,
  _organization: string | null,
): boolean {
  return false;
}

// 정규(금요일경계/현재) 대상 주차 시작 ms 를 그대로 반환한다(운영 정책 = 유일 정책).
//   base==null 이면 null 을 그대로 반환(현재 주차 계산 실패 전파).
export function resolveCluster4TestOpenableWeekStartMs(
  _mode: ScopeMode,
  baseStartMs: number | null,
  _opts: { hub: Cluster4TestWeekHub; organization: string | null },
): number | null {
  return baseStartMs;
}

// 호출부 가독성용 별칭(동일 pass-through).
export const getEffectiveWeekForAdminTestMode = resolveCluster4TestOpenableWeekStartMs;
