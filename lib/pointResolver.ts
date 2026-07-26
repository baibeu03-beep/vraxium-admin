import { supabaseAdmin } from "@/lib/supabaseAdmin";

// ─────────────────────────────────────────────────────────────────────
// 누적/주차 A·B·C 공통 Point Resolver — 전 표면(Cluster3 · /admin/members ·
// 관리자·크루 이력서 카드 · roster slim · weekly-card snapshot · 크루 주차/시즌
// 결과)이 반드시 이 모듈만 거친다. 화면별 직접 합산 금지.
//
// ── 원장 범위(2026-07-26 회귀 복구) ────────────────────────────────
// SoT = public.user_weekly_points (전체기간·무필터).
//   process_point_awards 는 "프로세스 체크 발 최신 적립"만 담는 부분 원장이다.
//   실측(2026-07-26): awards 1,084행 / uwp 14,581행, awards 의 (user,year,week)
//   키 205개가 **전부** uwp 에 동일 값으로 존재하고 awards 전용 키는 0개다.
//   즉 uwp ⊇ awards 이며 두 테이블을 합산하면 205키가 중복된다.
//   lib/processPointAccrual.ts recomputeWeeklyPoints() 가 적립·취소·롤백마다
//   해당 (user,year,week) 의 uwp 를 "활성 원장 합"으로 재계산(cancelled_at 제외)
//   하므로, uwp 는 최신 적립을 항상 반영하면서 아래 계층까지 함께 보유한다.
//     · year=1900 PMS/레거시 이관 누적(629행) — awards 에 존재하지 않음
//     · 2023~2025 과거 시즌 누적 — awards 에 존재하지 않음
//     · 레거시 수동/보충 포인트 — awards 에 존재하지 않음
//   awards 만 읽으면 위 계층이 통째로 사라져 세 자릿수 누적 A 가 두 자릿수로
//   축소된다(회귀 커밋 e180783). 취소분 제외는 uwp 재계산 단계에서 이미 끝나
//   있으므로 이 모듈에서 cancelled_at 를 다시 볼 필요가 없다.
//
// ── 계산 규칙(원장 범위와 무관한 확정 업무 규칙) ────────────────────
//   A = Σ points
//   rawAdvantage = Σ advantages
//   C = Σ |penalty|   (항상 양수 크기)
//   B = rawAdvantage − C
//   DB 의 penalty 원본 부호는 읽기만 하고 변경하지 않는다. 화면별 추가 부호
//   반전 금지 — C 는 모든 DTO 에서 양수로 나간다.
// ─────────────────────────────────────────────────────────────────────

export type ResolvedPoints = {
  pointA: number;
  pointB: number;
  pointC: number;
  rawAdvantage: number;
};

/** 원장 1행의 A/raw advantage/penalty 원시값. 테이블 중립(컬럼명 매핑은 호출부). */
export type PointAwardValues = {
  point_check?: number | null;
  point_advantage?: number | null;
  point_penalty?: number | null;
};

type WeeklyPointRow = {
  user_id: string;
  week_start_date: string | null;
  points: number | null;
  advantages: number | null;
  penalty: number | null;
};

const ID_CHUNK = 100; // IN() URL 길이 절벽 방어
const ROW_PAGE = 1000; // PostgREST max-rows 방어

/** user_weekly_points 행 → 테이블 중립 원장값. */
function toAwardValues(row: WeeklyPointRow): PointAwardValues {
  return {
    point_check: row.points,
    point_advantage: row.advantages,
    point_penalty: row.penalty,
  };
}

/** 확정 계산 규칙 단일 구현 — A/B/C 를 만드는 곳은 여기 하나뿐이다. */
export function resolvePointAwardRows(rows: readonly PointAwardValues[]): ResolvedPoints {
  let pointA = 0;
  let rawAdvantage = 0;
  let pointC = 0;
  for (const row of rows) {
    pointA += Number(row.point_check ?? 0);
    rawAdvantage += Number(row.point_advantage ?? 0);
    pointC += Math.abs(Number(row.point_penalty ?? 0));
  }
  return {
    pointA,
    pointB: rawAdvantage - pointC,
    pointC,
    rawAdvantage,
  };
}

/** 전체기간 누적 A/B/C (시즌·주차·연도 무필터 — 1900 이관 계층 포함). */
export async function resolveCumulativePointsBatch(
  userIds: readonly string[],
): Promise<Map<string, ResolvedPoints>> {
  return loadLedgerPoints(userIds, null);
}

/** 특정 ISO (year, week) 한 주차의 A/B/C (비누적). */
export async function resolveWeeklyPointsBatch(input: {
  userIds: readonly string[];
  year: number;
  weekNumber: number;
}): Promise<Map<string, ResolvedPoints>> {
  return loadLedgerPoints(input.userIds, {
    year: input.year,
    weekNumber: input.weekNumber,
  });
}

/** userId → (week_start_date → 그 주차 A/B/C). 주차/시즌 결과 표의 원천. */
export async function resolvePointHistoryBatch(
  inputIds: readonly string[],
): Promise<Map<string, Map<string, ResolvedPoints>>> {
  const ids = Array.from(new Set(inputIds.filter(Boolean)));
  const out = new Map<string, Map<string, ResolvedPoints>>();
  if (ids.length === 0) return out;

  // week_start_date 는 uwp 행이 직접 보유한다(weeks 조인 불필요). 조인을 쓰면
  // weeks 행이 없는 year=1900 이관 주차가 통째로 탈락하므로 조인하지 않는다.
  const grouped = new Map<string, PointAwardValues[]>();
  for (const row of await fetchWeeklyRows(ids, null)) {
    if (!row.week_start_date) continue;
    const key = `${row.user_id}::${row.week_start_date}`;
    const list = grouped.get(key) ?? [];
    list.push(toAwardValues(row));
    grouped.set(key, list);
  }

  for (const [key, rows] of grouped) {
    const sep = key.indexOf("::");
    const userId = key.slice(0, sep);
    const weekStart = key.slice(sep + 2);
    const user = out.get(userId) ?? new Map<string, ResolvedPoints>();
    user.set(weekStart, resolvePointAwardRows(rows));
    out.set(userId, user);
  }
  return out;
}

async function loadLedgerPoints(
  inputIds: readonly string[],
  week: { year: number; weekNumber: number } | null,
): Promise<Map<string, ResolvedPoints>> {
  const ids = Array.from(new Set(inputIds.filter(Boolean)));
  const out = new Map<string, ResolvedPoints>();
  if (ids.length === 0) return out;

  const rowsByUser = new Map<string, PointAwardValues[]>();
  for (const row of await fetchWeeklyRows(ids, week)) {
    const list = rowsByUser.get(row.user_id) ?? [];
    list.push(toAwardValues(row));
    rowsByUser.set(row.user_id, list);
  }
  // 행이 없는 사용자도 0 으로 채운다(호출부의 기존 미참여=0 시멘틱 유지).
  for (const id of ids) {
    out.set(id, resolvePointAwardRows(rowsByUser.get(id) ?? []));
  }
  return out;
}

/** user_weekly_points 읽기 단일 지점 — id 청크 × 행 페이지네이션. */
async function fetchWeeklyRows(
  ids: readonly string[],
  week: { year: number; weekNumber: number } | null,
): Promise<WeeklyPointRow[]> {
  const all: WeeklyPointRow[] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    let from = 0;
    for (;;) {
      let query = supabaseAdmin
        .from("user_weekly_points")
        .select("user_id,week_start_date,points,advantages,penalty")
        .in("user_id", chunk)
        // 페이지네이션 안정 정렬 — 고유키(id) 기준이라 행 중복/누락이 없다.
        .order("id", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (week) {
        query = query.eq("year", week.year).eq("week_number", week.weekNumber);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as WeeklyPointRow[];
      all.push(...rows);
      if (rows.length < ROW_PAGE) break;
      from += ROW_PAGE;
    }
  }
  return all;
}
