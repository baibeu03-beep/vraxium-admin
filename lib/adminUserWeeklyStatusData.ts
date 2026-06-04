// Server-only data layer for the admin "사용자별 주차 상태" 조회 화면.
//
// 조회 전용(read-only). 기존 계산 로직은 변경하지 않고 단순 조합만 한다.
// rows 기준 테이블은 user_week_statuses 이며, weeks 를 (iso_year, iso_week) 로
// 매칭해 시즌/주차 메타와 week_id 를 붙인다. weekly_reputations / weekly_colleagues
// 는 week_card_id(=weeks.id) 로 매칭하므로 weeks 매칭이 된 주차에서만 채워진다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { listWeeklyReputations } from "@/lib/weeklyReputationsData";
import { listWeeklyColleagues } from "@/lib/weeklyColleaguesData";
import type {
  UserWeeklyStatusDto,
  UserWeeklyStatusRow,
} from "@/lib/adminUserWeeklyStatusTypes";

type SeasonDefinitionRow = {
  season_key: string;
  season_label: string | null;
  season_type: string | null;
  start_date: string | null;
  end_date: string | null;
};

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
  iso_year: number | null;
  iso_week: number | null;
};

type UserWeekStatusRow = {
  status: string;
  year: number | null;
  week_number: number | null;
  week_start_date: string | null;
  is_official_rest_override: boolean | null;
  note: string | null;
};

type WeeklyPointRow = {
  year: number | null;
  week_number: number | null;
  points: number | null;
  advantages: number | null;
  penalty: number | null;
};

type GrowthStatsRow = {
  approved_weeks: number | null;
  cumulative_weeks: number | null;
};

const SEASON_TYPE_LABEL: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

function seasonName(season: SeasonDefinitionRow): string {
  return (
    season.season_label ??
    (season.season_type ? SEASON_TYPE_LABEL[season.season_type] : null) ??
    season.season_key
  );
}

function isoKey(year: number | null, week: number | null): string | null {
  if (year == null || week == null) return null;
  return `${year}::${week}`;
}

function toCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// 보조 테이블 미생성(42P01) 또는 "does not exist" 는 graceful degrade.
function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return (
    typeof error.message === "string" && /does not exist/i.test(error.message)
  );
}

// status='fail' 일 때만 실패 사유 추정값을 만든다. note 가 있으면 그대로,
// 없으면 일반 추정 문구. 그 외 상태는 null.
function estimateFailureReason(
  status: string,
  note: string | null,
): string | null {
  if (status !== "fail") return null;
  const trimmed = note?.trim();
  if (trimmed) return trimmed;
  return "인정 기준 미달(추정)";
}

export async function getUserWeeklyStatus(
  userId: string,
): Promise<UserWeeklyStatusDto> {
  const id = String(userId ?? "").trim();
  if (!id) {
    throw new Error("getUserWeeklyStatus: userId is required.");
  }

  // 1) 핵심 4종 조회 — 시즌/주차 메타 + 사용자 주차 상태 + 성장 캐시.
  const [seasonRes, weekRes, statusRes, growthRes] = await Promise.all([
    supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: true }),
    supabaseAdmin
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date,iso_year,iso_week")
      .order("start_date", { ascending: true }),
    supabaseAdmin
      .from("user_week_statuses")
      .select("status,year,week_number,week_start_date,is_official_rest_override,note")
      .eq("user_id", id),
    supabaseAdmin
      .from("user_growth_stats")
      .select("approved_weeks,cumulative_weeks")
      .eq("user_id", id)
      .maybeSingle(),
  ]);

  if (seasonRes.error) throw new Error(seasonRes.error.message);
  if (weekRes.error) throw new Error(weekRes.error.message);
  if (statusRes.error) throw new Error(statusRes.error.message);

  // user_growth_stats 는 캐시이므로 미생성/없음이면 요약값만 null 처리하고 진행.
  let growthAvailable = true;
  let growth: GrowthStatsRow | null = null;
  if (growthRes.error) {
    if (isMissingRelationError(growthRes.error)) {
      growthAvailable = false;
    } else {
      throw new Error(growthRes.error.message);
    }
  } else {
    growth = (growthRes.data ?? null) as GrowthStatsRow | null;
  }

  const seasons = (seasonRes.data ?? []) as SeasonDefinitionRow[];
  const weeks = (weekRes.data ?? []) as WeekRow[];
  const statuses = (statusRes.data ?? []) as UserWeekStatusRow[];

  const seasonByKey = new Map<string, SeasonDefinitionRow>();
  for (const s of seasons) seasonByKey.set(s.season_key, s);

  // weeks 를 ISO(year, week) 로 인덱싱 — user_week_statuses 와 동일 키 체계.
  const weekByIso = new Map<string, WeekRow>();
  for (const w of weeks) {
    const k = isoKey(w.iso_year, w.iso_week);
    if (k && !weekByIso.has(k)) weekByIso.set(k, w);
  }

  // 2) 보조 3종 조회 — 주차별 포인트 / 받은 평판 / 연계 동료.
  //    각각 미생성 가능 → available 플래그로 graceful degrade.
  const [pointsRes, reputationsRes, colleaguesRes] = await Promise.all([
    supabaseAdmin
      .from("user_weekly_points")
      .select("year,week_number,points,advantages,penalty")
      .eq("user_id", id),
    listWeeklyReputations({ targetUserId: id }).catch((error) => {
      console.error("[user-weekly-status] reputations failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { rows: [], available: false } as const;
    }),
    listWeeklyColleagues({ userId: id }).catch((error) => {
      console.error("[user-weekly-status] colleagues failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { rows: [], available: false } as const;
    }),
  ]);

  let pointsAvailable = true;
  let pointRows: WeeklyPointRow[] = [];
  if (pointsRes.error) {
    if (isMissingRelationError(pointsRes.error)) {
      pointsAvailable = false;
    } else {
      throw new Error(pointsRes.error.message);
    }
  } else {
    pointRows = (pointsRes.data ?? []) as WeeklyPointRow[];
  }

  // user_weekly_points 를 ISO 키로 인덱싱.
  const pointByIso = new Map<string, WeeklyPointRow>();
  for (const p of pointRows) {
    const k = isoKey(p.year, p.week_number);
    if (k) pointByIso.set(k, p);
  }

  // 받은 평판: week_card_id(=weeks.id) 별 count / 평균 rating.
  const reputationAgg = new Map<string, { count: number; sum: number }>();
  for (const r of reputationsRes.rows) {
    const key = r.week_card_id;
    if (!key) continue;
    const agg = reputationAgg.get(key) ?? { count: 0, sum: 0 };
    agg.count += 1;
    agg.sum += toCount(r.rating);
    reputationAgg.set(key, agg);
  }

  // 연계 동료: week_card_id 별 count.
  const colleagueCount = new Map<string, number>();
  for (const c of colleaguesRes.rows) {
    const key = c.week_card_id;
    if (!key) continue;
    colleagueCount.set(key, (colleagueCount.get(key) ?? 0) + 1);
  }

  // 3) rows 조립 — user_week_statuses 기준, 주차 시작일 오름차순.
  const sorted = [...statuses].sort((a, b) => {
    const av = a.week_start_date ?? "";
    const bv = b.week_start_date ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  const rows: UserWeeklyStatusRow[] = sorted.map((uws) => {
    const k = isoKey(uws.year, uws.week_number);
    const week = k ? weekByIso.get(k) ?? null : null;

    // 시즌: 매칭된 weeks.season_key 우선, 없으면 week_start_date 가 포함되는 시즌 탐색.
    let season: SeasonDefinitionRow | null = null;
    if (week?.season_key) {
      season = seasonByKey.get(week.season_key) ?? null;
    }
    if (!season && uws.week_start_date) {
      season =
        seasons.find(
          (s) =>
            s.start_date != null &&
            s.end_date != null &&
            s.start_date <= uws.week_start_date! &&
            uws.week_start_date! <= s.end_date,
        ) ?? null;
    }

    const weekNumber = week?.week_number ?? null;
    const weekLabel =
      weekNumber != null
        ? `${weekNumber}주차`
        : uws.week_number != null
          ? `${uws.week_number}주(ISO)`
          : "주차 미지정";

    const point = k ? pointByIso.get(k) ?? null : null;

    const repAgg = week ? reputationAgg.get(week.id) ?? null : null;
    const reputationCount = repAgg?.count ?? 0;
    const reputationScore =
      repAgg && repAgg.count > 0
        ? Math.round((repAgg.sum / repAgg.count) * 10) / 10
        : null;

    const status = uws.status;
    const weekStartDate = week?.start_date ?? uws.week_start_date ?? null;
    const isTransition = Boolean(
      weekStartDate && isTransitionWeekStart(weekStartDate),
    );

    return {
      user_id: id,
      season_key: season?.season_key ?? week?.season_key ?? null,
      season_label: season ? seasonName(season) : null,
      week_id: week?.id ?? null,
      week_number: weekNumber,
      week_label: weekLabel,
      week_start_date: weekStartDate,
      week_end_date: week?.end_date ?? null,
      status,
      // 전환 주차는 어떤 상태 카운트에도 포함하지 않는다(공식 휴식 아님).
      is_success: !isTransition && status === "success",
      is_fail: !isTransition && status === "fail",
      is_personal_rest: !isTransition && status === "personal_rest",
      is_official_rest: !isTransition && status === "official_rest",
      is_transition: isTransition,
      is_official_rest_override: uws.is_official_rest_override === true,
      weekly_star_count: toCount(point?.points),
      weekly_shield_count: toCount(point?.advantages),
      weekly_lightning_count: toCount(point?.penalty),
      // 고객 화면 표시 방패 = raw advantage − penalty (포인트 표시 정책 2026-06-04).
      weekly_net_shield_count:
        toCount(point?.advantages) - toCount(point?.penalty),
      weekly_reputation_count: reputationCount,
      reputation_score: reputationScore,
      colleague_count: week ? colleagueCount.get(week.id) ?? 0 : 0,
      failure_reason: estimateFailureReason(status, uws.note),
    };
  });

  // 4) 요약값 — 상태 카운트는 user_week_statuses 기준, 승인/누적은 캐시 기준.
  const summary = {
    // 전환 주차는 분모(total_weeks)에서도 제외. 상태 카운트는 is_* 가 이미 transition=false.
    total_weeks: rows.filter((r) => !r.is_transition).length,
    success_weeks: rows.filter((r) => r.is_success).length,
    fail_weeks: rows.filter((r) => r.is_fail).length,
    personal_rest_weeks: rows.filter((r) => r.is_personal_rest).length,
    official_rest_weeks: rows.filter((r) => r.is_official_rest).length,
    approved_weeks: growth ? toCount(growth.approved_weeks) : null,
    cumulative_weeks: growth ? toCount(growth.cumulative_weeks) : null,
  };

  return {
    user_id: id,
    summary,
    rows,
    sources: {
      growth_stats: growthAvailable,
      weekly_points: pointsAvailable,
      reputations: reputationsRes.available,
      colleagues: colleaguesRes.available,
    },
    generated_at: new Date().toISOString(),
  };
}
