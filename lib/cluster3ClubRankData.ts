import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { mapWithConcurrency } from "@/lib/concurrency";
import { GrowthError } from "@/lib/cluster3GrowthData";
import {
  type ClubRankDto,
  type RankGradeLabel,
  type WeeklyRankDetail,
  resolveRankGrade,
  formatAvgPercentile,
  toGradeNumber,
  toGradeLabel,
  GRADE_NUMBER_MAP,
} from "@/lib/cluster3GrowthTypes";

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
      .select("user_id,year,week_number,points,advantages,penalty")
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
export async function getRankPopulationExcludedUserIds(): Promise<Set<string>> {
  const excluded = new Set<string>();
  // 현재 시즌 season_key = 오늘이 속한 주차의 season_key (시즌 갭/전환이면 제외 없음 — 보수적).
  const today = new Date().toISOString().slice(0, 10);
  const wk = await supabaseAdmin
    .from("weeks")
    .select("season_key")
    .lte("start_date", today)
    .gte("end_date", today)
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (wk.error) throw new GrowthError(500, wk.error.message);
  const currentSeasonKey = (wk.data as { season_key?: string } | null)?.season_key ?? null;
  if (!currentSeasonKey) return excluded;

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
export type ClubRankGrade = { grade: number; label: string };

export async function getClubRankGradeBatch(
  userIds: string[],
): Promise<Map<string, ClubRankGrade | null>> {
  const result = new Map<string, ClubRankGrade | null>();
  if (userIds.length === 0) return result;

  const ID_CHUNK = 200;

  // 1) 대상자 growth_status(frozen 판정) + frozen 값 + 첫 주차(온보딩 제외) — 배치.
  const growthStatusById = new Map<string, string | null>();
  const frozenById = new Map<string, FrozenRow>();
  const firstWeekById = new Map<string, { year: number; week: number }>();
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
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
    for (const r of (profRes.data ?? []) as Array<{ user_id: string; growth_status: string | null }>) {
      growthStatusById.set(r.user_id, r.growth_status);
    }
    for (const r of (frozenRes.data ?? []) as Array<{ user_id: string } & FrozenRow>) {
      frozenById.set(r.user_id, { avg_percentile: r.avg_percentile, rank_grade: r.rank_grade });
    }
    for (const r of uwsRows) {
      const cur = firstWeekById.get(r.user_id);
      if (!cur || r.year < cur.year || (r.year === cur.year && r.week_number < cur.week)) {
        firstWeekById.set(r.user_id, { year: r.year, week: r.week_number });
      }
    }
  }

  // 2) 전체 user_weekly_points 1회 읽기(순위 모집단 = 전 사용자, getClubRank 과 동일 SoT/행).
  //    seasonal_rest 사용자는 모집단에서 제외(getClubRank 과 동일 정책·단일 SoT).
  //    readAllWeeklyPoints = count→병렬 페이지네이션(직렬 15왕복 → 병렬, parity 유지).
  const excludedIds = await getRankPopulationExcludedUserIds();
  const allPoints = await readAllWeeklyPoints();

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
      const label = frozen.rank_grade;
      const grade =
        label in GRADE_NUMBER_MAP ? GRADE_NUMBER_MAP[label as RankGradeLabel] : null;
      result.set(userId, grade != null ? { grade, label } : null);
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
    const label = resolveRankGrade(avgPercentile);
    result.set(userId, { grade: toGradeNumber(label), label });
  }

  return result;
}

// ─── user_grade_stats 동기화 ────────────────────────────────────────
//
// getClubRank() 결과를 user_grade_stats 에 UPSERT.
// 기존 데이터 DROP 없이 ON CONFLICT DO UPDATE 방식.

export async function syncGradeStats(userId: string): Promise<{
  avg_percentile: number | null;
  grade: number | null;
  grade_label: string | null;
}> {
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
  gradeStats: Awaited<ReturnType<typeof syncAllGradeStats>>;
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
  const gradeStats = await syncAllGradeStats();

  return { cumulativeResynced, gradeStats };
}
