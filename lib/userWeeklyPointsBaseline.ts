// user_weekly_points 포인트 계층 분리 SoT — "레거시/PMS 기준값" 과 "신규 award 기여분" 을
// 명시적으로 나누고, 최종 표시값을 그 합으로 정의한다.
//
// ── 왜 필요한가 (2026-07-26 회귀 원인) ────────────────────────────────
//   기존 recomputeWeeklyPoints() 는 (user, year, week) 의 user_weekly_points 를
//   **활성 process_point_awards 합만으로 통째로 덮었다.** 그 주차에 PMS·레거시 이관
//   포인트가 있어도 award 가 하나 생기는 순간 그 값이 award 합으로 치환되고, award 를
//   취소하면 0 이 된다. 실측 사례: 최윤하 2024-07-01 — 2026-07-16 08:32 라인 결과 award
//   1건 적립 → 08:35 취소 → PMS 48점이 0 으로 소멸(2026-07-25 §2 일괄 wipe 보다 9일 앞선
//   별개 손상). award 적립·취소가 있는 주차마다 재발한다.
//
// ── 계층 계약 ─────────────────────────────────────────────────────────
//   legacy_points / legacy_advantages / legacy_penalty  = PMS·레거시·QA 시드 기준값(불변층)
//   process_point_awards(cancelled_at IS NULL)          = 신규 award 기여분(가변층)
//   points / advantages / penalty                       = 두 층의 합(표시 SoT)
//
//     A            = legacy_points     + Σ award.point_check
//     rawAdvantage = legacy_advantages + Σ award.point_advantage
//     C            = legacy_penalty    + Σ |award.point_penalty|      (항상 양수 크기)
//     B            = rawAdvantage − C                                  (lib/pointResolver.ts)
//
//   award 를 적립/수정/취소/삭제해도 legacy_* 는 건드리지 않는다 → 취소 시 정확히
//   기준값으로 복귀한다. 재계산은 가산이 아니라 "legacy + 활성 award" 재구성이므로
//   몇 번을 돌려도 같은 값이다(멱등).
//
// ── 이중 합산이 없는 이유 ─────────────────────────────────────────────
//   두 층의 이벤트 식별 네임스페이스가 서로 겹치지 않는다:
//     legacy_point_ledger : UNIQUE(source_table, source_pk)  = PMS LogNum
//     process_point_awards: UNIQUE(source, ref_id, user_id)  = Vraxium 체크/액트/라인
//   같은 실제 사건이 양쪽에 들어가는 경로는 없다(PMS 컷오버 2026-06-08 · 적립 era 경계
//   2026-06-29). legacy_* 는 award 합을 **제외한** 잔여로 정의되므로 정의상 중복 불가.
//
// ── 컬럼 미적용 환경 ──────────────────────────────────────────────────
//   db/migrations/2026-07-26_uwp_legacy_baseline_columns.sql 미적용이면 legacy_* 가 없다.
//   그때는 "레거시층이 0 임이 구조적으로 보장되는 주차"(신정책 era = 2026-06-29 이후)에서만
//   기존 동작을 유지하고, 레거시 era 주차는 **쓰기를 건너뛴다**(파괴 금지 우선).
//   → 배포 순서: 마이그레이션 먼저, 그다음 코드 배포.

// ⚠ supabaseAdmin 은 프로브 함수 안에서 동적 import 한다 — 이 모듈의 순수 계산부
//   (composeWeeklyPointTotals·sumAwardTriple 등)를 DB 클라이언트 없이 단위 테스트하기 위해서다.

/** 포인트 3종 묶음(테이블 중립). penalty 는 항상 양수 크기. */
export type PointTriple = {
  points: number;
  advantages: number;
  penalty: number;
};

export const ZERO_TRIPLE: PointTriple = { points: 0, advantages: 0, penalty: 0 };

/**
 * 최종 표시값 = 레거시 기준층 + 활성 award 기여층.
 * 순수 함수(단일 SoT) — 합산 규칙을 만드는 곳은 여기 하나뿐이다. 가산 누적이 아니라
 * 두 입력으로부터 매번 재구성하므로 반복 호출해도 결과가 변하지 않는다.
 */
export function composeWeeklyPointTotals(baseline: PointTriple, awards: PointTriple): PointTriple {
  return {
    points: baseline.points + awards.points,
    advantages: baseline.advantages + awards.advantages,
    penalty: baseline.penalty + awards.penalty,
  };
}

/**
 * 활성 award 행들 → 기여층 합. penalty 는 절대값(양수 크기)으로 정규화한다.
 * 취소 행(cancelled_at)은 호출부가 이미 제외한 뒤 넘긴다.
 */
export function sumAwardTriple(
  rows: ReadonlyArray<{ point_check?: number | null; point_advantage?: number | null; point_penalty?: number | null }>,
): PointTriple {
  let points = 0;
  let advantages = 0;
  let penalty = 0;
  for (const r of rows) {
    points += r.point_check || 0;
    advantages += r.point_advantage || 0;
    penalty += Math.abs(r.point_penalty || 0);
  }
  return { points, advantages, penalty };
}

/**
 * 기존 uwp 행에서 레거시 기준층을 읽는다.
 *   legacy_* 가 채워져 있으면 그 값(마이그레이션 백필 완료 상태).
 *   NULL 이면 "아직 분리되지 않음" — 호출부가 fallback 정책을 결정한다.
 */
export function readBaselineFromRow(row: {
  legacy_points?: number | null;
  legacy_advantages?: number | null;
  legacy_penalty?: number | null;
} | null): PointTriple | null {
  if (!row) return null;
  if (row.legacy_points == null && row.legacy_advantages == null && row.legacy_penalty == null) return null;
  return {
    points: row.legacy_points ?? 0,
    advantages: row.legacy_advantages ?? 0,
    penalty: row.legacy_penalty ?? 0,
  };
}

export const LEGACY_BASELINE_SELECT = "legacy_points,legacy_advantages,legacy_penalty";

// ── legacy_* 컬럼 적용 여부 — 1회 프로브 후 캐시 ────────────────────────
//   processPointAwardsHasCancelColumns 와 동일 패턴(42703 = 컬럼 부재 확정 → 캐시).
//   순환 import 회피를 위해 의존성은 supabaseAdmin 하나로 유지한다.
let _hasBaselineCols: boolean | null = null;

export async function userWeeklyPointsHasLegacyBaselineColumns(): Promise<boolean> {
  if (_hasBaselineCols !== null) return _hasBaselineCols;
  const { supabaseAdmin } = await import("@/lib/supabaseAdmin");
  const res = await supabaseAdmin.from("user_weekly_points").select(LEGACY_BASELINE_SELECT).limit(1);
  if (!res.error) {
    _hasBaselineCols = true;
    return true;
  }
  const code = (res.error as { code?: string }).code;
  if (code === "42703" || code === "PGRST204") {
    _hasBaselineCols = false; // 컬럼 부재 확정 — 캐시
    return false;
  }
  return false; // 일시 오류 — 캐시하지 않고 보수적으로 미적용 취급
}

/** 테스트 전용 — 프로브 캐시 초기화. */
export function __resetLegacyBaselineProbeCache(): void {
  _hasBaselineCols = null;
}

/**
 * 컬럼 미적용 환경에서 "award 합으로 덮어써도 안전한 주차" 판정(순수).
 *
 * 신정책 era(2026-06-29 이후 시작 주차)는 레거시층이 구조적으로 0 이다:
 *   · PMS 컷오버 2026-06-08 · legacy_point_ledger 최종 occurred_at 2026-06-26
 *     (→ 귀속 주차 시작일 2026-06-22 < 2026-06-29)
 *   · QA 시드 test 행도 전부 2026-04 이전 주차
 * 따라서 그 주차에서는 "덮어쓰기 == legacy(0) + award" 로 결과가 동일하다.
 * 레거시 era 주차는 값이 있을 수 있으므로 쓰기를 건너뛴다(파괴 금지).
 */
export function isLegacyFreeWeek(weekStartDate: string | null | undefined, effectiveFrom: string): boolean {
  return typeof weekStartDate === "string" && weekStartDate >= effectiveFrom;
}
