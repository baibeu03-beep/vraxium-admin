import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { mapWithConcurrency } from "@/lib/concurrency";
import { GrowthError } from "@/lib/cluster3GrowthData";
import {
  type ClubRankDto,
  type RankGradeLabel,
  type WeeklyRankDetail,
  resolveRankGrade,
  resolveRankGradeDisplay,
  formatAvgPercentile,
  toGradeNumber,
  toGradeLabel,
} from "@/lib/cluster3GrowthTypes";
import {
  getClubRankComputation,
  invalidateClubRankComputationCache,
} from "@/lib/clubRankComputationCache";

// Cluster3 클럽 강화 품계 계산 — server-only.
//
// 계산 흐름:
//   1. user_weekly_points 에서 전 사용자의 주차별 (points, advantages, penalty) 조회
//   2. weekly_score = (points × 1) + (advantages × 3) - (penalty × 5)
//   3. 주차별 RANK (동점 동일 등수, 건너뜀)
//   4. 백분위: 1등=1%, 최하위=100%, 중간 균등 분배
//      total<=1 → 1, else CEIL(((rank-1)/(total-1))*99)+1
//   5. 평균 백분위 = 온보딩 1주차 제외한 주차별 백분위 평균
//   6. 품계 매핑
//
// graduated / suspended 사용자는 user_club_rank_frozen 에서 고정값 반환.

type WeeklyPointRow = {
  user_id: string;
  year: number;
  week_number: number;
  week_start_date: string | null; // as-of 윈도우(≤N) 판정 축 — 주차 이력 품계에서 사용.
  points: number;
  advantages: number;
  penalty: number;
};

type FrozenRow = {
  avg_percentile: number;
  rank_grade: string;
};

type ProfileStatusRow = {
  growth_status: string | null;
};

type UserWeekStatusRow = {
  year: number;
  week_number: number;
};

function computeWeeklyScore(row: { points: number; advantages: number; penalty: number }): number {
  return (row.points * 1) + (row.advantages * 3) - (row.penalty * 5);
}

// 전체 user_weekly_points(순위 모집단 = 전 사용자) 읽기 — getClubRank(개인)·getClubRankGradeBatch
// (어드민)이 공유(동일 SoT·동일 행 → 품계 parity 보장).
//   PostgREST max-rows(1000) 때문에 .range() 페이지네이션이 필수다. 종전엔 페이지를 직렬로 읽어
//   (14k행 = 15왕복 ≈ 2.5s) 라운드트립이 쌓이고 origin 점유 시간이 길었다. 전체 행수를 head count
//   로 먼저 구한 뒤 페이지들을 제한 동시성으로 병렬 조회한다 — 같은 행을 모두 읽어 합치므로 결과·
//   알고리즘은 불변(아래에서 주차별로 재그룹). origin 점유 시간을 줄여 포화(521/타임아웃)도 완화한다.
const POINTS_PAGE = 1000;
const POINTS_PAGE_CONCURRENCY = 4;
// 대상자 메타(uws/profiles/frozen) 청크 병렬도. 포인트 페이지 병렬도와 같은 수준으로 묶어
//   origin 동시 접속을 예측 가능하게 유지한다(DB 포화 가드와 같은 관례).
const CHUNK_CONCURRENCY = 4;
async function readAllWeeklyPoints(): Promise<WeeklyPointRow[]> {
  const { count, error: countErr } = await supabaseAdmin
    .from("user_weekly_points")
    .select("user_id", { count: "exact", head: true });
  if (countErr) throw new GrowthError(500, countErr.message);
  const total = count ?? 0;
  if (total === 0) return [];
  const pageCount = Math.ceil(total / POINTS_PAGE);
  const pageIndexes = Array.from({ length: pageCount }, (_, i) => i);
  const pages = await mapWithConcurrency(pageIndexes, POINTS_PAGE_CONCURRENCY, async (i) => {
    const from = i * POINTS_PAGE;
    const res = await supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,year,week_number,week_start_date,points,advantages,penalty")
      .order("year", { ascending: true })
      .order("week_number", { ascending: true })
      .order("user_id", { ascending: true })
      .range(from, from + POINTS_PAGE - 1);
    if (res.error) throw new GrowthError(500, res.error.message);
    return (res.data ?? []) as WeeklyPointRow[];
  });
  return pages.flat();
}

// ─── 품계 모집단 제외 정책 (단일 SoT) ──────────────────────────────────
//
// 시즌 전체 휴식자는 "현재 활동 인원"이 아니므로 상대 백분위 모집단에서 제외한다.
// 판정 기준 = 시즌 스코프 user_season_statuses(현재 시즌 season_key, status='rest').
//   ⚠ 종전엔 whole-person user_profiles.growth_status='seasonal_rest' 로 제외했으나, 이 플래그는
//     과거 시즌(예: 2026-spring) 휴식자에게 영구 잔존하여 다음 시즌(2026-summer)에 활동 재개해도
//     계속 제외되는 시즌 오인 버그가 있었다(growthCore 도 이 컬럼을 legacy 로 간주·미참조).
//     → 오늘 주차의 season_key 를 산출한 뒤 그 시즌 휴식자만 제외하도록 시즌 스코프로 정정.
// 과거 활동 이력(user_weekly_points·user_week_statuses)·snapshot·admin/members 표시는 전혀
//   건드리지 않는다 — 오직 품계 RANK 계산의 분모/순위에서만 빠진다.
//   본인 품계도 모집단에서 빠지므로(주차별 scored 에서 제거) targetEntry 부재 →
//   weeklyDetails 가 비어 avgPercentile=null(—) 이 된다(= 품계 계산에 미참여).
// getClubRank()·getClubRankGradeBatch() 두 모집단 빌더가 공통으로 호출한다.
// 품계 RANK 모집단에서 'rest'로 제외되는 기준 시즌 = 오늘이 속한 주차의 season_key.
// (시즌 갭/전환 시기는 null → 제외 없음, 보수적). season-status 변경이 품계 캐시를
//  스테일하게 만드는지 판단하는 freshness 훅에서도 공유한다(단일 SoT).
export async function getRankPopulationSeasonKey(): Promise<string | null> {
  const today = getCurrentActivityDateIso();
  const wk = await supabaseAdmin
    .from("weeks")
    .select("season_key")
    .lte("start_date", today)
    .gte("end_date", today)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wk.error) throw new GrowthError(500, wk.error.message);
  return (wk.data as { season_key?: string } | null)?.season_key ?? null;
}

export async function getRankPopulationExcludedUserIds(): Promise<Set<string>> {
  // 현재 시즌 season_key = 오늘이 속한 주차의 season_key (시즌 갭/전환이면 제외 없음 — 보수적).
  const currentSeasonKey = await getRankPopulationSeasonKey();
  return getRankPopulationExcludedUserIdsForSeason(currentSeasonKey);
}

// 특정 시즌(season_key) 기준 rest 제외 집합 — 현재 품계(오늘 시즌)와 as-of 이력 품계(그 주차 시즌)가
//   공유하는 단일 코어. season_key=null(시즌 갭/전환) → 제외 없음(보수적).
export async function getRankPopulationExcludedUserIdsForSeason(
  seasonKey: string | null,
): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (!seasonKey) return excluded;

  const currentSeasonKey = seasonKey;
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const res = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id")
      .eq("season_key", currentSeasonKey)
      .eq("status", "rest")
      .order("user_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (res.error) throw new GrowthError(500, res.error.message);
    const rows = (res.data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) excluded.add(r.user_id);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return excluded;
}

export async function getClubRank(userId: string): Promise<ClubRankDto> {
  const [profileRes, frozenRes, excludedIds] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("growth_status")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_club_rank_frozen")
      .select("avg_percentile,rank_grade")
      .eq("user_id", userId)
      .maybeSingle(),
    getRankPopulationExcludedUserIds(),
  ]);

  if (profileRes.error) throw new GrowthError(500, profileRes.error.message);
  const profile = profileRes.data as ProfileStatusRow | null;
  if (!profile) throw new GrowthError(404, "user_profiles not found");

  const frozen = (frozenRes.data ?? null) as FrozenRow | null;

  if (
    (profile.growth_status === "graduated" || profile.growth_status === "suspended") &&
    frozen
  ) {
    return {
      avgPercentile: Number(frozen.avg_percentile),
      avgPercentileDisplay: `상위 ${formatAvgPercentile(Number(frozen.avg_percentile))}%`,
      rankGrade: frozen.rank_grade,
      // frozen 도 같은 rank_grade 한 값에서 표시 3종을 파생 — 혼합 없음.
      ...resolveRankGradeDisplay(frozen.rank_grade),
      isFrozen: true,
      weeklyDetails: [],
    };
  }

  const userFirstWeekRes = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number")
    .eq("user_id", userId)
    .order("year", { ascending: true })
    .order("week_number", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (userFirstWeekRes.error) throw new GrowthError(500, userFirstWeekRes.error.message);
  const firstWeek = userFirstWeekRes.data as UserWeekStatusRow | null;

  // 주차별 RANK 는 전 사용자 대비 상대 순위라 user_weekly_points 전체가 필요하다.
  // (전체 row 가 1000 을 넘으면 무제한 select 는 조용히 잘려, 잘린 구간의 사용자는 weeklyDetails 가
  //  비어 avgPercentile=null 이 되고, 남은 사용자의 주차별 totalParticipants/순위도 틀어진다.)
  // readAllWeeklyPoints 가 count→병렬 페이지네이션으로 전 행을 읽는다(getClubRankGradeBatch 공유).
  const allPoints = await readAllWeeklyPoints();

  // 모집단 제외 정책: seasonal_rest 사용자의 행을 RANK 계산 전에 제거한다.
  // (대상 본인이 seasonal_rest 면 본인 행도 빠져 weeklyDetails 가 비고 avgPercentile=null.)
  const populationPoints =
    excludedIds.size === 0
      ? allPoints
      : allPoints.filter((r) => !excludedIds.has(r.user_id));

  if (populationPoints.length === 0) {
    return {
      avgPercentile: null,
      avgPercentileDisplay: "—",
      rankGrade: null,
      rankGradeNumber: null,
      rankGradeLabel: null,
      isFrozen: false,
      weeklyDetails: [],
    };
  }

  const byWeek = new Map<string, WeeklyPointRow[]>();
  for (const row of populationPoints) {
    const key = `${row.year}-${row.week_number}`;
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }

  const weeklyDetails: WeeklyRankDetail[] = [];

  for (const [, rows] of byWeek) {
    const scored = rows.map((r) => ({
      userId: r.user_id,
      score: computeWeeklyScore(r),
      year: r.year,
      weekNumber: r.week_number,
    }));

    scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const ranks: { userId: string; rank: number }[] = [];
    let currentRank = 1;

    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].score < scored[i - 1].score) {
        currentRank = i + 1;
      }
      ranks.push({ userId: scored[i].userId, rank: currentRank });
    }

    const targetEntry = ranks.find((r) => r.userId === userId);
    if (!targetEntry) continue;

    const targetScored = scored.find((s) => s.userId === userId)!;

    const percentile = total <= 1
      ? 1
      : Math.ceil(((targetEntry.rank - 1) / (total - 1)) * 99) + 1;

    const isOnboarding =
      firstWeek !== null &&
      targetScored.year === firstWeek.year &&
      targetScored.weekNumber === firstWeek.week_number;

    weeklyDetails.push({
      year: targetScored.year,
      weekNumber: targetScored.weekNumber,
      weeklyScore: targetScored.score,
      weeklyRank: targetEntry.rank,
      totalParticipants: total,
      weeklyPercentile: percentile,
      isOnboarding,
    });
  }

  weeklyDetails.sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.weekNumber - b.weekNumber,
  );

  const eligible = weeklyDetails.filter((d) => !d.isOnboarding);

  if (eligible.length === 0) {
    return {
      avgPercentile: null,
      avgPercentileDisplay: "—",
      rankGrade: null,
      rankGradeNumber: null,
      rankGradeLabel: null,
      isFrozen: false,
      weeklyDetails,
    };
  }

  const sum = eligible.reduce((acc, d) => acc + d.weeklyPercentile, 0);
  const rawAvg = sum / eligible.length;
  const avgPercentile = Math.ceil(rawAvg * 100) / 100;
  const rankGrade = resolveRankGrade(avgPercentile);

  return {
    avgPercentile,
    avgPercentileDisplay: `상위 ${formatAvgPercentile(avgPercentile)}%`,
    rankGrade,
    // 같은 avgPercentile → 같은 rankGrade → 표시 3종. 소비자가 재계산하지 않는다.
    ...resolveRankGradeDisplay(rankGrade),
    isFrozen: false,
    weeklyDetails,
  };
}

// ─── 품계 배치(어드민 크루 목록 /admin/members) ──────────────────────
// getClubRank()(고객 SoT)와 동일한 산식(weekly_score·주차 RANK·백분위·온보딩 1주차 제외·
// 평균 백분위→품계)을 사용자별 반복 호출(매번 전체 user_weekly_points 재조회) 대신
// 전체 포인트를 1회만 읽어 모든 대상자의 품계를 동시에 계산한다. user_grade_stats 캐시는
// 고객 화면이 참조하지 않아(club-rank 라우트=live) parity 가 깨지므로 사용하지 않는다.
//   graduated/suspended = user_club_rank_frozen 고정값(getClubRank 과 동일).
export type ClubRankGrade = { grade: number; label: string; avgPercentile: number | null };

// 단계별 소요시간 계측 — CLUB_RANK_PROFILE=1 일 때만 출력(기본 off, 계산에 영향 없음).
function stageProfiler(tag: string) {
  const on = process.env.CLUB_RANK_PROFILE === "1";
  const stages: Array<[string, number]> = [];
  let last = Date.now();
  return {
    mark(name: string) {
      const now = Date.now();
      stages.push([name, now - last]);
      last = now;
    },
    done(meta: Record<string, unknown>) {
      if (!on) return;
      console.log(`[clubRank][profile] ${tag}`, {
        ...meta,
        stages: Object.fromEntries(stages),
        totalMs: stages.reduce((a, [, ms]) => a + ms, 0),
      });
    },
  };
}

// 전수 계산 코어(캐시 없음). 산식·모집단·rest 제외·frozen·온보딩 제외는 종전과 완전히 동일하다 —
//   이 함수는 종전 getClubRankGradeBatch 의 본문 그대로이며, 바깥에 캐시 계층만 새로 씌웠다.
//   ⚠ 중요한 성질: 사용자별 결과는 roster 집합에 의존하지 않는다. 순위 모집단은 항상
//     "전 사용자 - rest 제외" 이고 userIds 는 "누구의 백분위를 기록할지"만 고른다.
//     → getClubRankGradeBatchUncached([u]) 와 (전체 계산 후 u 슬라이스)는 값이 동일하다.
//       캐시가 byte-identical 을 보장하는 근거가 이 성질이다.
export async function getClubRankGradeBatchUncached(
  userIds: string[],
): Promise<Map<string, ClubRankGrade | null>> {
  const result = new Map<string, ClubRankGrade | null>();
  if (userIds.length === 0) return result;

  const prof = stageProfiler("gradeBatch");
  const ID_CHUNK = 200;

  // 1) 대상자 growth_status(frozen 판정) + frozen 값 + 첫 주차(온보딩 제외) — 배치.
  //    청크는 서로 독립(사용자 집합이 겹치지 않음)이라 **제한 동시성으로 병렬** 실행한다.
  //    ⚠ 쿼리·필터·정렬·행 집합은 종전과 완전히 동일하다 — 직렬 왕복을 겹쳤을 뿐이다.
  //      (직렬일 때 이 단계가 전체 계산의 70%(≈1.4s)를 먹는 최대 병목이었다.)
  const growthStatusById = new Map<string, string | null>();
  const frozenById = new Map<string, FrozenRow>();
  const firstWeekById = new Map<string, { year: number; week: number }>();
  const idChunks: string[][] = [];
  for (let i = 0; i < userIds.length; i += ID_CHUNK) idChunks.push(userIds.slice(i, i + ID_CHUNK));

  const loadChunk = async (chunk: string[]) => {
    // user_week_statuses 는 사용자당 다수 주차 행이라 200명 청크의 .in() 결과가 기본
    // 1000행 cap 을 넘기면 조용히 잘려 firstWeek(온보딩 첫 주차)가 틀어진다 → 온보딩
    // 제외 주차가 어긋나 getClubRank(개인) 과 batch(관리자) 의 품계가 갈린다.
    // .range() 페이지네이션으로 전 행을 읽어 정확한 min(year,week)을 보장한다.
    const uwsRows: Array<{ user_id: string; year: number; week_number: number }> = [];
    {
      const UWS_PAGE = 1000;
      let uwsFrom = 0;
      for (;;) {
        const r = await supabaseAdmin
          .from("user_week_statuses")
          .select("user_id,year,week_number")
          .in("user_id", chunk)
          .order("user_id", { ascending: true })
          .order("year", { ascending: true })
          .order("week_number", { ascending: true })
          .range(uwsFrom, uwsFrom + UWS_PAGE - 1);
        if (r.error) throw new GrowthError(500, r.error.message);
        const rows = (r.data ?? []) as Array<{ user_id: string; year: number; week_number: number }>;
        uwsRows.push(...rows);
        if (rows.length < UWS_PAGE) break;
        uwsFrom += UWS_PAGE;
      }
    }
    const [profRes, frozenRes] = await Promise.all([
      supabaseAdmin.from("user_profiles").select("user_id,growth_status").in("user_id", chunk),
      supabaseAdmin
        .from("user_club_rank_frozen")
        .select("user_id,avg_percentile,rank_grade")
        .in("user_id", chunk),
    ]);
    if (profRes.error) throw new GrowthError(500, profRes.error.message);
    if (frozenRes.error) throw new GrowthError(500, frozenRes.error.message);
    return { uwsRows, profRows: profRes.data ?? [], frozenRows: frozenRes.data ?? [] };
  };

  // 2) 전체 user_weekly_points(순위 모집단 = 전 사용자, getClubRank 과 동일 SoT/행) + rest 제외 집합.
  //    seasonal_rest 사용자는 모집단에서 제외(getClubRank 과 동일 정책·단일 SoT).
  //    ①대상자 메타 ②rest 제외 ③전체 포인트는 서로 의존이 없으므로 함께 출발시킨다.
  const [chunkResults, excludedIds, allPoints] = await Promise.all([
    mapWithConcurrency(idChunks, CHUNK_CONCURRENCY, loadChunk),
    getRankPopulationExcludedUserIds(),
    readAllWeeklyPoints(),
  ]);
  // 병합은 청크 순서대로 — Map 키가 사용자별로 겹치지 않아 순서에 무관하지만 결정적으로 둔다.
  for (const c of chunkResults) {
    for (const r of c.profRows as Array<{ user_id: string; growth_status: string | null }>) {
      growthStatusById.set(r.user_id, r.growth_status);
    }
    for (const r of c.frozenRows as Array<{ user_id: string } & FrozenRow>) {
      frozenById.set(r.user_id, { avg_percentile: r.avg_percentile, rank_grade: r.rank_grade });
    }
    for (const r of c.uwsRows) {
      const cur = firstWeekById.get(r.user_id);
      if (!cur || r.year < cur.year || (r.year === cur.year && r.week_number < cur.week)) {
        firstWeekById.set(r.user_id, { year: r.year, week: r.week_number });
      }
    }
  }
  prof.mark("uws+profiles+frozen ∥ rest제외 ∥ user_weekly_points");

  const populationPoints =
    excludedIds.size === 0
      ? allPoints
      : allPoints.filter((r) => !excludedIds.has(r.user_id));

  // 3) 주차별 RANK → 백분위. 대상자(roster)만 백분위 기록.
  //    roster 에 seasonal_rest 가 섞여 있어도 모집단에서 빠져 자연히 grade=null(—).
  const rosterSet = new Set(userIds);
  const pctByUser = new Map<string, Array<{ year: number; week: number; pct: number }>>();
  const byWeek = new Map<string, WeeklyPointRow[]>();
  for (const row of populationPoints) {
    const key = `${row.year}-${row.week_number}`;
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }
  for (const [, rows] of byWeek) {
    const scored = rows.map((r) => ({ userId: r.user_id, score: computeWeeklyScore(r), year: r.year, week: r.week_number }));
    scored.sort((a, b) => b.score - a.score);
    const total = scored.length;
    let currentRank = 1;
    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].score < scored[i - 1].score) currentRank = i + 1;
      const s = scored[i];
      if (!rosterSet.has(s.userId)) continue;
      const pct = total <= 1 ? 1 : Math.ceil(((currentRank - 1) / (total - 1)) * 99) + 1;
      const list = pctByUser.get(s.userId) ?? [];
      list.push({ year: s.year, week: s.week, pct });
      pctByUser.set(s.userId, list);
    }
  }

  // 4) 사용자별 평균 백분위(온보딩 1주차 제외) → 품계. frozen 우선.
  for (const userId of userIds) {
    const gs = growthStatusById.get(userId);
    const frozen = frozenById.get(userId);
    if ((gs === "graduated" || gs === "suspended") && frozen) {
      // frozen 도 getClubRank 과 **같은 변환 한 곳**(resolveRankGradeDisplay)을 통과시킨다.
      //   종전엔 rank_grade 문자열을 GRADE_NUMBER_MAP 에 직접 넣어, 과거 기록의 공백 표기
      //   ("정 3품")가 키에 없어 품계가 통째로 null 로 떨어졌다(getClubRank 은 공백을 정규화해
      //   정상 반환 → 같은 사용자의 품계가 두 화면에서 갈렸다).
      const d = resolveRankGradeDisplay(frozen.rank_grade);
      result.set(
        userId,
        d.rankGradeNumber != null && d.rankGradeLabel != null
          ? {
              grade: d.rankGradeNumber,
              label: d.rankGradeLabel,
              avgPercentile: frozen.avg_percentile ?? null,
            }
          : null,
      );
      continue;
    }
    const details = pctByUser.get(userId) ?? [];
    const first = firstWeekById.get(userId);
    const eligible = details.filter(
      (d) => !(first && d.year === first.year && d.week === first.week),
    );
    if (eligible.length === 0) {
      result.set(userId, null);
      continue;
    }
    const rawAvg = eligible.reduce((acc, d) => acc + d.pct, 0) / eligible.length;
    const avgPercentile = Math.ceil(rawAvg * 100) / 100;
    // 표시 3종은 avgPercentile 하나에서 ClubRankDto 와 **동일 경로**로 파생한다
    //   (resolveRankGrade → resolveRankGradeDisplay). label 을 raw 구간명으로 두면 어드민은
    //   "정3품", 고객 club-rank 는 "정 3품" 이 되어 같은 값이 다르게 보인다.
    const d = resolveRankGradeDisplay(resolveRankGrade(avgPercentile));
    result.set(
      userId,
      d.rankGradeNumber != null && d.rankGradeLabel != null
        ? { grade: d.rankGradeNumber, label: d.rankGradeLabel, avgPercentile }
        : null,
    );
  }
  prof.mark("JS 점수·순위·백분위·품계");
  prof.done({ requested: userIds.length, points: allPoints.length, excluded: excludedIds.size });

  return result;
}

// ─── 캐시 계층 (전체 모집단 계산 1덩어리 · TTL · single-flight) ──────────────
//
// 캐시 유니버스 = user_profiles 전원. 로스터·쇼케이스·club-rank 대상자는 모두 프로필 보유자라
//   이 집합으로 덮인다. 요청 대상 중 하나라도 유니버스에 없으면 캐시를 쓰지 않고 그 요청만
//   직접 계산한다 — 캐시분과 신규 계산분을 섞어 **서로 다른 계산 시점이 한 화면에 공존**하는
//   것을 막기 위해서다(부분 교체 금지 계약).
async function loadAllProfileUserIds(): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error) throw new GrowthError(500, res.error.message);
    const rows = (res.data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) ids.push(r.user_id);
    if (rows.length < PAGE) break;
  }
  return ids;
}

/**
 * 품계 배치 — 기본은 짧은 TTL 캐시(전체 모집단 계산 1덩어리)를 재사용한다.
 *
 * @param options.forceRefresh 캐시를 건너뛰고 지금 시점으로 재계산한다.
 *   주차 공표처럼 값이 snapshot 에 확정되는 경로가 사용한다(30초 전 값으로 확정 금지).
 *   ⚠ 캐시 사용 여부만 다르고 **계산식·DTO·모집단은 완전히 동일**하다(같은 코어 함수).
 */
export async function getClubRankGradeBatch(
  userIds: string[],
  options?: { forceRefresh?: boolean },
): Promise<Map<string, ClubRankGrade | null>> {
  const result = new Map<string, ClubRankGrade | null>();
  if (userIds.length === 0) return result;

  const computation = await getClubRankComputation<ClubRankGrade | null>(
    async () => getClubRankGradeBatchUncached(await loadAllProfileUserIds()),
    { forceRefresh: options?.forceRefresh },
  );

  // 유니버스 밖 사용자가 섞여 있으면 캐시를 쓰지 않는다(시점 혼입 금지).
  for (const id of userIds) {
    if (!computation.map.has(id)) return getClubRankGradeBatchUncached(userIds);
  }
  for (const id of userIds) result.set(id, computation.map.get(id) ?? null);
  return result;
}

// ─── as-of 주차 이력 품계 배치 (주차별 확정 품계 SoT용) ──────────────────
// 특정 주차(week_start_date ≤ asOfWeekStartDate) 시점의 확정 품계 — getClubRankGradeBatch 와 동일
//   산식(weekly_score·주차 RANK·백분위·온보딩 1주차 제외·평균)이되 3가지만 다르다:
//     ⑴ 평균 대상 주차를 week_start_date ≤ asOf 로 **윈도우**(그 주차까지의 누적 상태).
//     ⑵ rest 제외 population 을 **asOfSeasonKey**(그 주차 시즌) 기준 — 오늘 시즌 아님(재현 가능).
//     ⑶ **frozen(졸업/정지) override 미적용** — 그 주차엔 활동 중이었으므로 실제 백분위로 산출.
//   주차별 백분위는 주차 간 독립이라 같은 주차 pct 는 그때·지금 동일 → 재검수/backfill 재현성 보장.
//   math fork 아님 — readAllWeeklyPoints·computeWeeklyScore·resolveRankGrade 공통 코어 재사용.
export async function computeAsOfClubRankGradeBatch(params: {
  userIds: string[];
  asOfWeekStartDate: string;
  asOfSeasonKey: string | null;
}): Promise<Map<string, ClubRankGrade | null>> {
  const { userIds, asOfWeekStartDate, asOfSeasonKey } = params;
  const result = new Map<string, ClubRankGrade | null>();
  if (userIds.length === 0) return result;

  // 첫 주차(온보딩 제외 판정) — 배치. getClubRankGradeBatch 와 동일한 min(year,week_number).
  const firstWeekById = new Map<string, { year: number; week: number }>();
  const ID_CHUNK = 200;
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
    const UWS_PAGE = 1000;
    let uwsFrom = 0;
    for (;;) {
      const r = await supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,year,week_number")
        .in("user_id", chunk)
        .order("user_id", { ascending: true })
        .order("year", { ascending: true })
        .order("week_number", { ascending: true })
        .range(uwsFrom, uwsFrom + UWS_PAGE - 1);
      if (r.error) throw new GrowthError(500, r.error.message);
      const rows = (r.data ?? []) as Array<{ user_id: string; year: number; week_number: number }>;
      for (const row of rows) {
        const cur = firstWeekById.get(row.user_id);
        if (!cur || row.year < cur.year || (row.year === cur.year && row.week_number < cur.week)) {
          firstWeekById.set(row.user_id, { year: row.year, week: row.week_number });
        }
      }
      if (rows.length < UWS_PAGE) break;
      uwsFrom += UWS_PAGE;
    }
  }

  const excludedIds = await getRankPopulationExcludedUserIdsForSeason(asOfSeasonKey);
  const allPoints = await readAllWeeklyPoints();

  // 윈도우(≤asOf) + rest 제외.
  const populationPoints = allPoints.filter(
    (r) =>
      !excludedIds.has(r.user_id) &&
      r.week_start_date != null &&
      r.week_start_date <= asOfWeekStartDate,
  );

  // 주차 버킷 = week_start_date(각 고유 주차). roster 만 백분위 기록.
  const rosterSet = new Set(userIds);
  const pctByUser = new Map<string, Array<{ year: number; week: number; pct: number }>>();
  const byWeek = new Map<string, WeeklyPointRow[]>();
  for (const row of populationPoints) {
    const key = row.week_start_date as string;
    const list = byWeek.get(key) ?? [];
    list.push(row);
    byWeek.set(key, list);
  }
  for (const [, rows] of byWeek) {
    const scored = rows.map((r) => ({ userId: r.user_id, score: computeWeeklyScore(r), year: r.year, week: r.week_number }));
    scored.sort((a, b) => b.score - a.score);
    const total = scored.length;
    let currentRank = 1;
    for (let i = 0; i < scored.length; i++) {
      if (i > 0 && scored[i].score < scored[i - 1].score) currentRank = i + 1;
      const s = scored[i];
      if (!rosterSet.has(s.userId)) continue;
      const pct = total <= 1 ? 1 : Math.ceil(((currentRank - 1) / (total - 1)) * 99) + 1;
      const list = pctByUser.get(s.userId) ?? [];
      list.push({ year: s.year, week: s.week, pct });
      pctByUser.set(s.userId, list);
    }
  }

  for (const userId of userIds) {
    const details = pctByUser.get(userId) ?? [];
    const first = firstWeekById.get(userId);
    const eligible = details.filter(
      (d) => !(first && d.year === first.year && d.week === first.week),
    );
    if (eligible.length === 0) {
      result.set(userId, null);
      continue;
    }
    const rawAvg = eligible.reduce((acc, d) => acc + d.pct, 0) / eligible.length;
    const avgPercentile = Math.ceil(rawAvg * 100) / 100;
    const label = resolveRankGrade(avgPercentile);
    result.set(userId, { grade: toGradeNumber(label), label, avgPercentile });
  }

  return result;
}

// ─── 배치 재동기 (1회 전체 스캔) ────────────────────────────────────────
// getClubRankGradeBatch(1회 readAllWeeklyPoints) 로 모든 대상자의 품계를 계산해
//   user_grade_stats 에 UPSERT 한다. syncAllGradeStats(사용자별 getClubRank=N회 풀스캔)의
//   배치 대체 — 전체를 1회만 스캔. userIds 미지정 시 organization_slug 보유 전 사용자.
//   품계 null(모집단 제외/이력 부재) = grade/avg null 로 UPSERT(스테일 잔존 방지).
export async function resyncGradeStatsBatch(
  userIds?: string[],
): Promise<{ total: number; graded: number; nulled: number }> {
  let targets = userIds ?? null;
  if (!targets) {
    const all: string[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin
        .from("user_profiles")
        .select("user_id")
        .not("organization_slug", "is", null)
        .order("user_id", { ascending: true })
        .range(from, from + 999);
      if (error) throw new GrowthError(500, error.message);
      const rows = (data ?? []) as Array<{ user_id: string }>;
      all.push(...rows.map((r) => r.user_id));
      if (rows.length < 1000) break;
    }
    targets = all;
  }
  if (targets.length === 0) return { total: 0, graded: 0, nulled: 0 };

  // 캐시 테이블에 값을 굳히는 경로라 TTL 캐시를 쓰지 않는다(옛 계산 시점 고착 방지).
  //   forceRefresh 계산 결과가 그대로 새 캐시가 되므로 별도 invalidate 는 불필요하다
  //   (시즌 rest 변경·주차 재판정이 이 경로를 타고 들어와 캐시까지 함께 갱신된다).
  const grades = await getClubRankGradeBatch(targets, { forceRefresh: true }); // 1회 전체 스캔
  const nowIso = new Date().toISOString();
  let graded = 0, nulled = 0;
  const payload = targets.map((userId) => {
    const g = grades.get(userId) ?? null;
    if (g) graded++; else nulled++;
    return {
      user_id: userId,
      avg_percentile: g?.avgPercentile ?? null,
      grade: g?.grade ?? null,
      grade_label: g?.label ?? null,
      updated_at: nowIso,
    };
  });
  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await supabaseAdmin
      .from("user_grade_stats")
      .upsert(payload.slice(i, i + 200), { onConflict: "user_id" });
    if (error) throw new GrowthError(500, `resyncGradeStatsBatch upsert: ${error.message}`);
  }
  return { total: targets.length, graded, nulled };
}

// ─── user_grade_stats 동기화 ────────────────────────────────────────
//
// getClubRank() 결과를 user_grade_stats 에 UPSERT.
// 기존 데이터 DROP 없이 ON CONFLICT DO UPDATE 방식.

// 이 함수는 "포인트/시즌상태가 바뀐 뒤" 호출되는 공통 후처리 지점이다(적립 훅·PMS 동기화·
//   관리자 rank sync 가 전부 여기로 들어온다). 그래서 club-rank 전수 계산 캐시 무효화도 여기서
//   함께 건다 — 각 호출부가 무효화를 따로 기억할 필요가 없다.
//   ⚠ 무효화는 **읽기 전에** 건다. getClubRank(아래)이 지금 시점 값을 읽어야 하기 때문이다.
export async function syncGradeStats(userId: string): Promise<{
  avg_percentile: number | null;
  grade: number | null;
  grade_label: string | null;
}> {
  invalidateClubRankComputationCache("syncGradeStats");
  const clubRank = await getClubRank(userId);

  if (clubRank.avgPercentile === null || clubRank.rankGrade === null) {
    return { avg_percentile: null, grade: null, grade_label: null };
  }

  const avgPct = Number(formatAvgPercentile(clubRank.avgPercentile));
  const gradeNum = toGradeNumber(clubRank.rankGrade as RankGradeLabel);
  const gradeLbl = toGradeLabel(clubRank.rankGrade as RankGradeLabel);

  // updated_at 을 명시적으로 넣어야 ON CONFLICT DO UPDATE 시 캐시 신선도가 갱신된다.
  // (Supabase upsert 는 페이로드에 준 컬럼만 UPDATE 하므로, 생략하면 컬럼
  //  DEFAULT now() 는 INSERT 에만 적용되고 갱신 경로에서 updated_at 이 고정된다.)
  const { error } = await supabaseAdmin
    .from("user_grade_stats")
    .upsert(
      {
        user_id: userId,
        avg_percentile: avgPct,
        grade: gradeNum,
        grade_label: gradeLbl,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

  if (error) throw new GrowthError(500, `syncGradeStats failed: ${error.message}`);

  return { avg_percentile: avgPct, grade: gradeNum, grade_label: gradeLbl };
}

export async function syncAllGradeStats(): Promise<{
  synced: number;
  skipped: number;
  results: Array<{ userId: string; avg_percentile: number | null; grade: number | null; grade_label: string | null }>;
}> {
  const { data: users, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .not("organization_slug", "is", null);

  if (error) throw new GrowthError(500, error.message);
  if (!users || users.length === 0) return { synced: 0, skipped: 0, results: [] };

  const results: Array<{ userId: string; avg_percentile: number | null; grade: number | null; grade_label: string | null }> = [];
  let synced = 0;
  let skipped = 0;

  for (const user of users as Array<{ user_id: string }>) {
    try {
      const result = await syncGradeStats(user.user_id);
      if (result.grade !== null) {
        synced++;
      } else {
        skipped++;
      }
      results.push({ userId: user.user_id, ...result });
    } catch {
      skipped++;
      results.push({ userId: user.user_id, avg_percentile: null, grade: null, grade_label: null });
    }
  }

  return { synced, skipped, results };
}

// ─── app-level 캐시 동기화 오케스트레이터 ────────────────────────────
//
// user_weekly_points 변경(seed/script/admin API) 직후 호출한다.
// DB 트리거가 아니라 app-level 에서 순서를 명시적으로 보장한다.
//
// 순서:
//   1) cumulative points 재계산
//      user_weekly_points 쓰기는 DB 트리거 sync_cumulative_on_weekly_change 가
//      같은 트랜잭션에서 user_cumulative_points 를 동기화한다. 다만 트리거 우회
//      경로(bulk COPY, 트리거 미설치 환경 등)에 대비해, 변경된 user_id 가 주어지면
//      sync_cumulative_points_for_user RPC 로 한 번 더 명시적으로 재계산한다.
//      (RPC 는 weekly 합계를 다시 UPSERT 하므로 idempotent.)
//   2) grade stats 재계산
//      품계는 "상대" 백분위 기반이라 한 사용자만 갱신하면 나머지 사용자의 주차별
//      순위·총원이 틀어진다. 반드시 syncAllGradeStats() 로 전체 사용자를 재계산한다.

export type GrowthCacheSyncResult = {
  cumulativeResynced: number;
  gradeStats: Awaited<ReturnType<typeof resyncGradeStatsBatch>>;
};

export async function syncGrowthCachesAfterPointsChange(
  options: { affectedUserIds?: string[] } = {},
): Promise<GrowthCacheSyncResult> {
  const affectedUserIds = options.affectedUserIds ?? [];

  // 1) cumulative 재계산 (변경된 사용자만 — 명시적 순서 보장)
  let cumulativeResynced = 0;
  for (const userId of affectedUserIds) {
    const { error } = await supabaseAdmin.rpc("sync_cumulative_points_for_user", {
      p_user_id: userId,
    });
    if (error) {
      throw new GrowthError(
        500,
        `cumulative resync failed for ${userId}: ${error.message}`,
      );
    }
    cumulativeResynced++;
  }

  // 2) grade stats 전체 재계산 (상대 백분위 → 전체 사용자 필수)
  //    syncAllGradeStats(사용자별 getClubRank = N회 풀스캔) → resyncGradeStatsBatch(1회 스캔).
  const gradeStats = await resyncGradeStatsBatch();

  return { cumulativeResynced, gradeStats };
}
