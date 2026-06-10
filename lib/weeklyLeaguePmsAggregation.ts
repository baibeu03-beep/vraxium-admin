// Weekly League 봄 시즌 정합 집계 — admin 이식본 (numbers only).
//
// ⚠ 새 공식 설계 금지. 이 파일은 front repo(../vraxium/lib/weekly-league.ts)의 이미 적용·검증된
//   aggregateWeeklyLeague() 집계 로직(commit 87dd4ea "spring exception correction")을 admin repo 로
//   1:1 이식한 것이다(동일 Supabase 테이블·동일 SoT). front/admin 별 빌드라 import 불가 → 포팅.
//   결과: 2026 ORANKE 봄 W1~W13 가 front /weekly-ranking 과 100% 일치.
//
// 적용 범위(데이터·시즌 게이트):
//   - 시즌 = WEEKLY_LEAGUE_SEASON_KEY('2026-spring') 만(front 와 동일). 종료된 주차(end_date<today)만.
//   - 공식 휴식 주차(weeks.is_official_rest, 전환주차 제외) → 전부 0 카드(front 와 동일).
//   - PMS 공식: cluster4_weekly_pms_activity 행 존재 AND effectiveConfirmStar 있는 주차만.
//       effectiveConfirmStar = cluster4_weekly_ranking_exceptions.confirm_star_override
//                              ?? org_week_thresholds.check_threshold.
//       success = pms.submitted AND pms.star>=4 AND uwp.points>=ecs AND ¬rest  (uws.success 무조건절 없음)
//       cohort  = ¬cohort_exclude AND (uws행 존재 OR uwp.points>=ecs OR isRest)
//   - 그 외 주차 → 기존 uws.status 버킷팅(success/rest/else=fail) — front fallback 과 동일.
//   - 로스터 = user_profiles(organization_slug=org, status∈active/seasonal_rest/weekly_rest/graduated)
//             − test_user_markers (front 와 동일 — 105 문제 방지).
//   - 휴식(personal/official)은 personalRest 로 합산(front 와 동일). uws/uwp/개인카드/snapshot 무변경.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { isOrganizationSlug } from "@/lib/organizations";

// front WEEKLY_LEAGUE_SEASON_KEY 와 동일 값(미러). 여름 자동 비활성.
export const WEEKLY_LEAGUE_SEASON_KEY = "2026-spring";

const ROSTER_STATUSES = ["active", "seasonal_rest", "weekly_rest", "graduated"];

export type WeeklyLeagueWeekAgg = {
  weekId: string;
  weekNumber: number;
  startDate: string;
  isOfficialRest: boolean;
  usePmsFormula: boolean;
  effectiveConfirmStar: number | null;
  totalCrew: number;
  growthChallenge: number;
  growthSuccess: number;
  growthFail: number;
  // front 와 동일: personal+official 휴식을 personalRest 로 합산. (officialRest 는 항상 0 — 매핑 호환)
  personalRest: number;
  officialRest: number;
  cohortUserIds: string[];
};

export type WeeklyLeagueAggregationResult = {
  usable: boolean; // org 가 weekly-league org 이고 로스터/주차가 있어 집계를 산출했는가.
  byWeekId: Map<string, WeeklyLeagueWeekAgg>;
};

// 전환 주차 판정(front lib/cluster4-transition-week 미러): 봄·가을 17 / 여름·겨울 9.
function isTransitionWeek(seasonKey: string, weekNumber: number): boolean {
  const s = seasonKey.toLowerCase();
  const springFall = s.includes("spring") || s.includes("fall") || s.includes("autumn");
  const summerWinter = s.includes("summer") || s.includes("winter");
  if (springFall && weekNumber === 17) return true;
  if (summerWinter && weekNumber === 9) return true;
  return false;
}

export async function computeWeeklyLeagueAggregation(
  org: string | null | undefined,
): Promise<WeeklyLeagueAggregationResult> {
  const empty: WeeklyLeagueAggregationResult = { usable: false, byWeekId: new Map() };
  if (!org || !isOrganizationSlug(org)) return empty;

  const today = new Date().toISOString().split("T")[0];

  // 0) 테스트 유저 제외 집합.
  const testUserIds = await fetchTestUserMarkerIds();

  // 0-1) 회원명부(printUsers) 모드 게이트(front 미러) — weekly_league_roster_orgs 등록 org 만.
  //   ON: 모집단=회원명부(운영진/시즌전체휴식/graduated/test 제외), 휴식=crew_personal_rest_periods.
  //   OFF: 현행 활동행(user_week_statuses) 경로 — 숫자 불변.
  let memberRosterMode = false;
  {
    const { data: gateRows } = await supabaseAdmin
      .from("weekly_league_roster_orgs")
      .select("organization_slug")
      .eq("organization_slug", org)
      .eq("enabled", true);
    memberRosterMode = !!(gateRows && gateRows.length > 0);
  }
  const operatorIds = new Set<string>();
  if (memberRosterMode) {
    const { data: ops } = await supabaseAdmin
      .from("operator_markers")
      .select("user_id")
      .eq("organization_slug", org);
    for (const o of (ops ?? []) as { user_id: string }[]) operatorIds.add(o.user_id);
  }

  // 1) org 로스터 — status 필터 + 테스트 제외(front 157~168). 회원명부 모드: 운영진/시즌전체휴식/graduated 추가 제외.
  const { data: rosterRaw, error: rosterErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, status, activity_started_at, current_team_name")
    .eq("organization_slug", org)
    .in("status", ROSTER_STATUSES);
  if (rosterErr) {
    console.warn("[weekly-league-agg] roster 조회 실패", rosterErr.message);
    return empty;
  }
  type RosterRow = { user_id: string; status: string | null; activity_started_at: string | null; current_team_name: string | null };
  const orgProfiles = ((rosterRaw ?? []) as RosterRow[]).filter((p) => {
    if (testUserIds.has(p.user_id)) return false;
    if (memberRosterMode) {
      if (p.status === "graduated") return false;            // PMS 졸업 제외
      if (operatorIds.has(p.user_id)) return false;          // PMS 운영진 제외
      if (p.current_team_name === "시즌전체휴식") return false; // PMS Team 제외
    }
    return true;
  });
  const orgUserIds = orgProfiles.map((p) => p.user_id);
  if (orgUserIds.length === 0) return { usable: true, byWeekId: new Map() };

  // 2) 종료된 2026-spring 주차 메타(front 179~218). season_definitions join 없이 weeks 만 사용
  //    (2026-spring 은 isBreak=false 이므로 baseOfficialRest = weeks.is_official_rest).
  const { data: weekRows, error: weekErr } = await supabaseAdmin
    .from("weeks")
    .select("id, week_number, start_date, end_date, is_official_rest")
    .eq("season_key", WEEKLY_LEAGUE_SEASON_KEY)
    .lt("end_date", today)
    .order("start_date", { ascending: false });
  if (weekErr) {
    console.warn("[weekly-league-agg] weeks 조회 실패", weekErr.message);
    return empty;
  }
  const weeks = ((weekRows ?? []) as {
    id: string;
    week_number: number | null;
    start_date: string;
    end_date: string;
    is_official_rest: boolean | null;
  }[]).map((w) => ({
    id: w.id,
    weekNumber: w.week_number ?? 0,
    startDate: w.start_date,
    endDate: w.end_date,
    isOfficialRest: !!w.is_official_rest,
  }));
  if (weeks.length === 0) return { usable: true, byWeekId: new Map() };

  // 1-1) 개인휴식 기간(회원명부 모드 전용) — crew_personal_rest_periods (restdates 격리·uws 무관).
  const restPeriods: Array<{ user_id: string; start_date: string; end_date: string }> = [];
  if (memberRosterMode) {
    const { data: rp } = await supabaseAdmin
      .from("crew_personal_rest_periods")
      .select("user_id, start_date, end_date")
      .eq("organization_slug", org);
    for (const r of (rp ?? []) as { user_id: string; start_date: string; end_date: string }[]) restPeriods.push(r);
  }

  // 1-2) 주차별 성공수 집계 보정(회원명부 모드 전용·front 미러) — weekly_league_success_overrides.
  //   PMS 실측 성공수 주차별 override(사람별 verdict 아님). total/rest 무접촉, success/fail split 만.
  const successOverrideByWeekStart = new Map<string, number>();
  if (memberRosterMode) {
    const { data: ov, error: ovErr } = await supabaseAdmin
      .from("weekly_league_success_overrides")
      .select("week_start_date, growth_success")
      .eq("organization_slug", org);
    if (ovErr) console.warn("[weekly-league-agg] success_overrides 조회 실패 — 미적용", ovErr.message);
    else for (const o of (ov ?? []) as { week_start_date: string; growth_success: number }[]) successOverrideByWeekStart.set(o.week_start_date, Number(o.growth_success));
  }

  // 3) uws / uwp (로스터 한정, READ only).
  const [uwsRes, uwpRes] = await Promise.all([
    fetchAllByUsers<{ user_id: string; week_start_date: string; status: string }>(
      "user_week_statuses",
      "user_id, week_start_date, status",
      orgUserIds,
    ),
    fetchAllByUsers<{ user_id: string; week_start_date: string; points: number | null }>(
      "user_weekly_points",
      "user_id, week_start_date, points",
      orgUserIds,
    ),
  ]);
  const statusByUserWeek = new Map<string, string>();
  const statusByWeek = new Map<string, { user_id: string; status: string }[]>();
  for (const r of uwsRes) {
    statusByUserWeek.set(`${r.user_id}|${r.week_start_date}`, r.status);
    const arr = statusByWeek.get(r.week_start_date) ?? [];
    arr.push({ user_id: r.user_id, status: r.status });
    statusByWeek.set(r.week_start_date, arr);
  }
  const pointsByUserWeek = new Map<string, number>();
  for (const r of uwpRes) pointsByUserWeek.set(`${r.user_id}|${r.week_start_date}`, Number(r.points) || 0);

  // 4) PMS 활동 신호(로스터 한정) → per-(user,week) + weeksWithPmsData(front 293~309).
  const pmsRows = await fetchAllByUsers<{
    user_id: string; week_start_date: string; user_activity_submitted: boolean; user_activity_star: number | null;
  }>(
    "cluster4_weekly_pms_activity",
    "user_id, week_start_date, user_activity_submitted, user_activity_star",
    orgUserIds,
  );
  const pmsByUserWeek = new Map<string, { submitted: boolean; star: number | null }>();
  const weeksWithPmsData = new Set<string>();
  for (const r of pmsRows) {
    pmsByUserWeek.set(`${r.user_id}|${r.week_start_date}`, {
      submitted: !!r.user_activity_submitted,
      star: r.user_activity_star,
    });
    weeksWithPmsData.add(r.week_start_date);
  }

  // 5) org_week_thresholds.check_threshold (front 310~316).
  const weekIds = weeks.map((w) => w.id);
  const { data: owtRows } = await supabaseAdmin
    .from("org_week_thresholds")
    .select("week_id, check_threshold")
    .eq("organization_slug", org)
    .in("week_id", weekIds);
  const confirmStarByWeekId = new Map<string, number>();
  for (const r of (owtRows ?? []) as { week_id: string; check_threshold: number | null }[]) {
    if (r.check_threshold != null) confirmStarByWeekId.set(r.week_id, Number(r.check_threshold));
  }

  // 6) 봄 정합 예외(front 6-1) — cluster4_weekly_ranking_exceptions (org + season_key).
  const confirmStarOverrideByWeekId = new Map<string, number>();
  const cohortExcludeKey = new Set<string>(); // `${user_id}|${week_id}`
  {
    const { data: exRows } = await supabaseAdmin
      .from("cluster4_weekly_ranking_exceptions")
      .select("week_id, user_id, exception_type, int_value")
      .eq("organization_slug", org)
      .eq("season_key", WEEKLY_LEAGUE_SEASON_KEY);
    for (const e of (exRows ?? []) as {
      week_id: string; user_id: string | null; exception_type: string; int_value: number | null;
    }[]) {
      if (e.exception_type === "confirm_star_override" && e.int_value != null) {
        confirmStarOverrideByWeekId.set(e.week_id, Number(e.int_value));
      } else if (e.exception_type === "cohort_exclude" && e.user_id) {
        cohortExcludeKey.add(`${e.user_id}|${e.week_id}`);
      }
    }
  }

  // 7) 주차별 집계(front 334~450, 숫자만).
  const byWeekId = new Map<string, WeeklyLeagueWeekAgg>();
  for (const week of weeks) {
    const weekOfficialRest =
      !isTransitionWeek(WEEKLY_LEAGUE_SEASON_KEY, week.weekNumber) && week.isOfficialRest;

    if (weekOfficialRest) {
      byWeekId.set(week.id, {
        weekId: week.id, weekNumber: week.weekNumber, startDate: week.startDate,
        isOfficialRest: true, usePmsFormula: false, effectiveConfirmStar: null,
        totalCrew: 0, growthChallenge: 0, growthSuccess: 0, growthFail: 0,
        personalRest: 0, officialRest: 0, cohortUserIds: [],
      });
      continue;
    }

    let growthSuccess = 0;
    let growthFail = 0;
    let personalRest = 0;
    const cohortUserIds: string[] = [];
    let usePmsFormula = false;
    let effectiveConfirmStar: number | null = null;

    if (memberRosterMode) {
      // ── 회원명부(printUsers) 모드(front 미러) ──
      //   모집단 = activity_started_at <= 주차종료 인 로스터(운영진/시즌전체휴식/graduated/test 이미 제외).
      //   휴식 = crew_personal_rest_periods overlap. 성공 = uws.status='success'. (uws 무수정)
      const restUserIds = new Set(
        restPeriods.filter((r) => r.start_date <= week.endDate && r.end_date >= week.startDate).map((r) => r.user_id),
      );
      for (const p of orgProfiles) {
        const started = p.activity_started_at;
        if (!started || started.slice(0, 10) > week.endDate) continue;
        cohortUserIds.push(p.user_id);
        if (restUserIds.has(p.user_id)) { personalRest++; continue; }
        const st = statusByUserWeek.get(`${p.user_id}|${week.startDate}`) ?? null;
        if (st === "success") growthSuccess++;
        else growthFail++;
      }
      // 주차별 성공수 집계 보정 — PMS 실측 override (total/rest 불변, success/fail split 만).
      const ovSuccess = successOverrideByWeekStart.get(week.startDate);
      if (ovSuccess != null) {
        const nonRest = growthSuccess + growthFail;
        growthSuccess = Math.min(ovSuccess, nonRest);
        growthFail = nonRest - growthSuccess;
      }
    } else {
    effectiveConfirmStar =
      confirmStarOverrideByWeekId.get(week.id) ?? confirmStarByWeekId.get(week.id) ?? null;
    usePmsFormula = weeksWithPmsData.has(week.startDate) && effectiveConfirmStar != null;

    if (usePmsFormula) {
      const ecs = effectiveConfirmStar as number;
      for (const uid of orgUserIds) {
        if (cohortExcludeKey.has(`${uid}|${week.id}`)) continue;
        const st = statusByUserWeek.get(`${uid}|${week.startDate}`) ?? null;
        const pts = pointsByUserWeek.get(`${uid}|${week.startDate}`) ?? null;
        const isRest = st === "personal_rest" || st === "official_rest";
        const inCohort = st !== null || (pts ?? 0) >= ecs || isRest;
        if (!inCohort) continue;
        cohortUserIds.push(uid);
        if (isRest) { personalRest++; continue; }
        const pa = pmsByUserWeek.get(`${uid}|${week.startDate}`);
        const isSuccess = !!pa?.submitted && (pa.star ?? -1) >= 4 && (pts ?? -1) >= ecs;
        if (isSuccess) growthSuccess++;
        else growthFail++;
      }
    } else {
      // 기존 uws.status 버킷팅(front else). 로스터의 uws 행만(점수 only 미포함).
      const rows = statusByWeek.get(week.startDate) ?? [];
      for (const r of rows) {
        cohortUserIds.push(r.user_id);
        if (r.status === "success") growthSuccess++;
        else if (r.status === "personal_rest" || r.status === "official_rest") personalRest++;
        else growthFail++;
      }
    }
    }

    const growthChallenge = growthSuccess + growthFail;
    byWeekId.set(week.id, {
      weekId: week.id, weekNumber: week.weekNumber, startDate: week.startDate,
      isOfficialRest: false, usePmsFormula, effectiveConfirmStar,
      totalCrew: growthChallenge + personalRest,
      growthChallenge, growthSuccess, growthFail,
      personalRest, officialRest: 0, cohortUserIds,
    });
  }

  return { usable: true, byWeekId };
}

// PostgREST 1000행 cap 회피 — user_id 안정 정렬 + range 페이지네이션(front fetchAllRows 미러).
async function fetchAllByUsers<T>(
  table: string,
  select: string,
  userIds: string[],
): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(select)
      .in("user_id", userIds)
      .order("user_id", { ascending: true })
      .order("week_start_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn(`[weekly-league-agg] ${table} 조회 실패`, error.message);
      break;
    }
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}
