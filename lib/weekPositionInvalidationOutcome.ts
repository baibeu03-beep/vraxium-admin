import type { WeeklyCardsInvalidationResult } from "@/lib/cluster4WeeklyCardsSnapshot";

// 주차 파트/클래스 저장(PATCH team-detail/week-position) 후 "무효화 결과 → HTTP 응답" 결정 규칙.
// ─────────────────────────────────────────────────────────────────────
// 라우트에서 분리한 이유: 이 판정이 곧 **크루앱 수렴 보장**이라 서버 없이 단위 검증할 수 있어야 한다
// (scripts/verify-week-position-invalidation-outcome.ts).
//
// 규칙:
//   · invalidated == null            → 무효화 자체가 예외로 죽음(폴백 markStale 도 실패) → 500.
//   · invalidated.ok === false       → is_stale 마킹 실패 = 옛 카드가 fresh 로 남을 수 있음 → 500.
//       (override 행은 이미 기록됐지만 upsert 는 멱등이라 관리자가 그대로 재시도하면 복구된다.)
//   · ok === true, recomputeFailed>0 → 즉시 재계산만 일부 실패. is_stale=true 가 남아 조회 lazy/cron
//       이 반드시 복구하므로 저장은 성공. 다만 "반영 지연 가능"을 warning 으로 반드시 노출한다.
//   · ok === true, recomputeFailed=0 → 완전 성공.
//
// ⚠ 어떤 경우에도 실패를 **조용히 삼키지 않는다**(2026-07-22 회귀 방지). 종전에는 예외를 로그로만
//   남기고 항상 success:true 를 반환해, 크루앱이 옛 팀/파트/클래스를 계속 노출해도 관리자는 알 수 없었다.

export const WEEK_POSITION_INVALIDATION_FAILED_MESSAGE =
  "저장은 기록됐지만 크루앱 주차 카드 캐시 무효화에 실패했습니다. " +
  "그대로 두면 크루앱에 이전 소속/클래스가 계속 표시됩니다 — 다시 저장해 주세요.";

export type WeekPositionInvalidationOutcome =
  | { ok: true; status: 200; warning: string | null }
  | { ok: false; status: 500; error: string };

export function resolveWeekPositionInvalidationOutcome(
  invalidated: WeeklyCardsInvalidationResult | null,
): WeekPositionInvalidationOutcome {
  if (!invalidated || !invalidated.ok) {
    return { ok: false, status: 500, error: WEEK_POSITION_INVALIDATION_FAILED_MESSAGE };
  }
  const warning =
    invalidated.recomputeFailed > 0
      ? `${invalidated.recomputeFailed}명은 즉시 재계산에 실패해 stale 로 표시했습니다 — 크루앱 다음 조회 시 반영됩니다.`
      : null;
  return { ok: true, status: 200, warning };
}
