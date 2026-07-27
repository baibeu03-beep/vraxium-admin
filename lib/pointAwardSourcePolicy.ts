// process_point_awards.source 분류 정책 — 두 allowlist 의 단일 SoT (2026-07-27).
//
// 원장 한 테이블이 성격이 다른 두 집계에 쓰인다. 어느 source 가 어느 집계에 들어가는지를
// **각 호출부가 각자 판단하지 않도록** 여기 한 곳에 못박는다.
//
//   ① 주차 총 Point A  — user_weekly_points.points 에 합산되는 원장
//   ② 액트 수행 집계    — 액트 체크 수 / 체크율 / required 이행 / 액트 적립 내역
//
// 정책(2026-07-27 확정):
//   · 'regular'(정규 액트 체크) · 'irregular'(변동 액트) → ①②  **둘 다** 포함
//   · 'line'(라인 강화 시 포인트) · 'line_rating'(실무 경험 평점 Point A) → ① **포함** / ② **제외**
//     라인 포인트는 크루의 주차 총점이자 주차 성공 판정 입력이지만, "액트를 수행했다"는 뜻이
//     아니므로 액트 수행률·이행 개수에는 절대 들어가지 않는다. 상세 내역에서도 액트 탭이 아니라
//     "라인 강화 내역"(강화 시 포인트 / 평점 Point A 로 다시 분리)에 표시된다.
//
// ── 두 목록의 실패 방향이 서로 다르다(의도된 비대칭) ──────────────────────────
//   ② 액트 집계 = **fail-closed(strict)**. 새 source 가 생겨도 액트로 자동 편입되지 않는다.
//      액트가 아닌 지급이 액트율에 섞이는 사고(2026-07-13 'line' 도입 후 실제 발생)를 구조적으로 막는다.
//   ① 포인트 합계 = **fail-open**. 목록에 없는 source 를 만나면 **합산에 포함하되 error 로 알린다**.
//      여기서 fail-closed 로 두면 새 지급 경로가 추가된 순간 크루 주차 포인트가 **조용히 사라지고**
//      주차 성공 판정까지 뒤집힌다(2026-07-25 uwp wipe 와 같은 유형의 사고). 포인트는 소실이
//      오염보다 훨씬 파괴적이므로 "일단 세고 크게 알린다"가 옳다. [[project_uwp-legacy-award-layering]]

import type { AccrualSource } from "@/lib/processPointAccrual";

// 실제 액트 수행을 뜻하는 source — ② 액트 수행 집계 allowlist(strict).
//   ⚠ 새 source 를 여기 넣기 전에 "이게 크루가 수행한 액트인가"를 먼저 답할 것.
export const ACT_PERFORMANCE_SOURCES: readonly string[] = ["regular", "irregular"];

// 주차 총 Point A(user_weekly_points.points)에 합산되는 source — ① 포인트 합계 allowlist.
//   ⚠ 액트 2종 + 라인 2종. 라인 포인트는 주차 총점·주차 성공 판정에 **포함된다**.
export const WEEK_POINT_A_SOURCES: readonly string[] = [
  "regular", // 정규 액트 체크
  "irregular", // 변동 액트
  "line", // 라인 강화 시 포인트(cluster4_line_point_configs 설정값)
  "line_rating", // 실무 경험 평점 Point A(실제 평점 그대로)
];

/** ② 액트 수행 집계에 넣을 원장인가. strict — 모르는 source 는 false. */
export function isActPerformanceSource(source: string): boolean {
  return ACT_PERFORMANCE_SOURCES.includes(source);
}

/**
 * ① 주차 총 Point A 합계에 넣을 원장인가. fail-open —
 * 목록에 없는 source 도 true 를 돌려주되 console.error 로 알린다(포인트 소실 방지 우선).
 * 로그는 (source 당 1회) 로 눌러 재계산 루프에서 폭주하지 않게 한다.
 */
const warnedUnknownSources = new Set<string>();
export function isWeekPointASource(source: string): boolean {
  if (WEEK_POINT_A_SOURCES.includes(source)) return true;
  if (!warnedUnknownSources.has(source)) {
    warnedUnknownSources.add(source);
    console.error(
      `[pointAwardSourcePolicy] 미등록 원장 source='${source}' — 주차 Point A 합계에 일단 포함했습니다. ` +
        `lib/pointAwardSourcePolicy.ts 의 WEEK_POINT_A_SOURCES / ACT_PERFORMANCE_SOURCES 에 분류를 명시해주세요.`,
    );
  }
  return true; // fail-open: 분류 누락으로 포인트가 사라지지 않게 한다.
}

// 타입 수준 정합 — AccrualSource 가 늘어나면 여기서 분류를 갱신하라는 신호.
//   (컴파일 에러로 강제하지는 않는다 — 위 fail-open 이 런타임 안전망이다.)
export type KnownAwardSource = AccrualSource;
