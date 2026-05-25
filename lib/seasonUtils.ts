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
 * 규칙:
 *  1) 날짜가 시즌 범위(start_date ~ end_date) 안이면 해당 시즌
 *  2) 시즌 사이 gap이면 직전 시즌 (end_date 기준 가장 가까운)
 *  3) 모든 시즌 이전이면 null
 */
export function resolveSeasonKey(
  date: string | Date,
  seasons: SeasonDef[],
): string | null {
  const d = typeof date === "string" ? new Date(date + "T00:00:00Z") : date;
  const ts = d.getTime();

  // 1차: 범위 안
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
