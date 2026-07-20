// 시즌 귀속 유틸 — browser-safe.
// DB의 resolve_season_key(date) SQL 함수와 동일한 로직을 TS로 구현.

export type SeasonDef = {
  seasonKey: string;
  startDate: string; // 'YYYY-MM-DD'
  endDate: string;   // 'YYYY-MM-DD'
};

/**
 * 주어진 날짜가 어느 시즌에 귀속되는지 결정.
 *
 * 규칙 (SQL resolve_season_key 와 동일 — 2026-07-20 전환 주차 재귀속 반영):
 *  1) 등록된 전환 주차(weeks.week_number = 0) 범위 안이면 그 주차의 season_key(다음 시즌)
 *  2) 날짜가 시즌 범위(start_date ~ end_date) 안이면 해당 시즌
 *  3) (방어) 시즌 사이 gap이면 직전 시즌 (end_date 기준 가장 가까운) — 전환은 1)에서 처리
 *  4) 모든 시즌 이전이면 null
 *
 * transitionWeeks 미전달(기본 [])이면 1) 을 건너뛴다(구 동작 = 순수 season_definitions).
 */
export function resolveSeasonKey(
  date: string | Date,
  seasons: SeasonDef[],
  transitionWeeks: SeasonDef[] = [],
): string | null {
  const d = typeof date === "string" ? new Date(date + "T00:00:00Z") : date;
  const ts = d.getTime();

  // 1차: 등록된 전환 주차(week_number=0) — weeks SoT. 날짜 추측 금지.
  for (const t of transitionWeeks) {
    const start = new Date(t.startDate + "T00:00:00Z").getTime();
    const end = new Date(t.endDate + "T00:00:00Z").getTime();
    if (ts >= start && ts <= end) return t.seasonKey;
  }

  // 2차: 범위 안
  for (const s of seasons) {
    const start = new Date(s.startDate + "T00:00:00Z").getTime();
    const end = new Date(s.endDate + "T00:00:00Z").getTime();
    if (ts >= start && ts <= end) return s.seasonKey;
  }

  // 2차: gap → 직전 시즌 (end_date < date, 가장 가까운)
  let best: SeasonDef | null = null;
  let bestEnd = -Infinity;
  for (const s of seasons) {
    const end = new Date(s.endDate + "T00:00:00Z").getTime();
    if (end < ts && end > bestEnd) {
      best = s;
      bestEnd = end;
    }
  }

  return best?.seasonKey ?? null;
}
