// 주차 결과(크루) — 크루 종합 지표 집계. **고객 앱 /weekly-ranking 규칙의 1:1 이식본.**
//
// ⚠ 새 산식 설계 금지. 이 파일은 front repo `../vraxium/lib/weekly-league.ts` 의
//   aggregateWeeklyLeague() 가 쓰는 **회원명부(memberRosterMode) 분기**를 그대로 옮긴 것이다
//   (동일 Supabase 테이블·동일 필터·동일 버킷팅). front/admin 은 별도 빌드라 import 가 불가능해
//   포팅했다 — lib/weeklyLeaguePmsAggregation.ts(2026-spring 전용 이식본)와 같은 선례다.
//
// 왜 memberRosterMode 분기인가:
//   weekly_league_roster_orgs 에 encre/oranke/phalanx **3개 조직이 모두 등록**되어 있어
//   현재 모든 조직이 이 분기를 탄다(실측 2026-07-22). PMS 공식 분기는
//   cluster4_weekly_pms_activity 가 있는 주차(2026-03~05 봄)만 타므로 2026-summer 에는 해당 없음.
//
// ── 이식한 규칙(front 918~930행) ─────────────────────────────────────────────
//   모집단(로스터) = user_profiles(organization_slug=org, status ∈ active/seasonal_rest/weekly_rest/graduated)
//     − test_user_markers(scope: operating=테스트 제외 / test=테스트만)
//     − status='graduated'            (PMS 졸업 제외)
//     − operator_markers              (PMS 운영진 제외)
//     − current_team_name='시즌전체휴식' (PMS 시즌 전체 휴식 제외)
//     − 미시작: effectiveStart(weekly_league_member_start.member_start_date ?? activity_started_at)
//               이 주차 종료일보다 뒤면 그 주차 모집단에서 제외
//   개인 휴식 = crew_personal_rest_periods 가 주차[start,end] 와 overlap  (⚠ uws.status 미사용)
//   성장 성공 = user_week_statuses.status === 'success'
//   성장 실패 = 그 외 전부(uws fail/기타/행 없음) — **차감이 아니라 직접 카운트**
//   성공수 보정 = weekly_league_success_overrides (total/rest 불변, success/fail split 만)
//   공식 휴식 주차 = 전 지표 하드 0 (front 875~897행)
//
// ── 시즌 휴식(seasonRest) — admin 신규 산출 ─────────────────────────────────
//   ⚠ 고객 앱은 이 값을 **서버에서 한 번도 채우지 않는다**(weekly-league.ts 에 seasonRest 0회 등장).
//     UI(WeeklyDetailContent)는 card.seasonRest ?? 0 을 읽으므로 운영 화면에서 항상 0 이다.
//     즉 고객 앱의 "소속 크루"(totalCrew = seasonRest + personalRest + challenge)는 실질적으로
//     시즌 휴식자를 세지 않은 수다.
//   사용자 요구는 "소속 크루에 시즌 휴식자 포함" 이므로, admin 은 시즌 휴식자를 실제로 세어
//     고객 UI 가 이미 선언한 등식(소속 = 시즌휴식 + 개인휴식 + 도전)을 그대로 충족시킨다.
//
//   판정 SoT = `user_season_statuses(user_id, season_key).status = 'rest'` — **그 주차가 속한 시즌** 기준.
//   ⚠⚠ `user_profiles.current_team_name = '시즌전체휴식'` 을 쓰면 안 된다(실측 2026-07-22):
//        · current_team_name='시즌전체휴식' = encre 155 / oranke 143 / phalanx 61 (합 359)
//          → PMS 이관 휴면 명부(정적 버킷). 특정 시즌의 휴식자가 아니다. front 가 로스터에서
//            아예 제외하는 대상이며, 이를 시즌 휴식으로 세면 소속 크루가 294 로 부풀려진다.
//        · user_season_statuses(2026-summer, rest) = encre 38 / oranke 11 / phalanx 8 (합 57)
//          → 실제 그 시즌 휴식자. 이 중 22명만 '시즌전체휴식' 팀이고 35명은 정상 팀 소속이다.
//      두 신호는 서로 다른 개념이라 대체 불가.
//   → 로스터는 front 규칙(휴면 제외) 그대로 두고, 그 안에서 시즌 휴식 상태인 인원만 분리 집계한다.
//     따라서 admin 소속 크루 = 고객 앱 소속 크루 + (로스터 ∩ 시즌 휴식자).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import type { OrganizationSlug } from "@/lib/organizations";
import type { OrgResultScope } from "@/lib/weekOrgResultState";

// front 로스터 status 필터와 동일.
const ROSTER_STATUSES = ["active", "seasonal_rest", "weekly_rest", "graduated"];
// front 가 로스터에서 제외하는 PMS 시즌 전체 휴식 팀명(= admin 의 시즌 휴식 집계 대상).
const SEASON_REST_TEAM_NAME = "시즌전체휴식";

// 결과 산식 버전 — 공표 snapshot(calculation_version)에 각인해 재현/감사에 쓴다.
//   ⚠ 지표 산식(모집단 필터·휴식 판정·성공/실패 규칙·비율 분모)이 바뀌면 반드시 올린다.
export const CREW_METRICS_CALC_VERSION = 1;

// null = 미확정(마스킹). 0 과 반드시 구분한다 — 0 은 "실제로 0명", null 은 "아직 보여줄 수 없음".
export type CrewWeeklyMetrics = {
  memberCount: number | null;
  seasonRestCount: number | null;
  personalRestCount: number | null;
  growthChallengeCount: number | null;
  growthSuccessCount: number | null;
  growthFailureCount: number | null;
  /** 0~100 정수(고객 앱과 동일 반올림). 분모 0 → 0. */
  growthSuccessRatePercent: number | null;
  growthChallengeRatePercent: number | null;
};

// 공식 휴식 주차 = 전 지표 하드 0(front 875~897행).
export const EMPTY_CREW_WEEKLY_METRICS: CrewWeeklyMetrics = {
  memberCount: 0,
  seasonRestCount: 0,
  personalRestCount: 0,
  growthChallengeCount: 0,
  growthSuccessCount: 0,
  growthFailureCount: 0,
  growthSuccessRatePercent: 0,
  growthChallengeRatePercent: 0,
};

// 미확정 주차(검수 완료 아님) = 결과 지표 전부 비노출.
//   고객 앱 WeeklyDetailContent 의 isTallying → 'N' 마스킹과 동일 규칙.
//   ⚠ "uws 행 없음 = 실패" 계산은 확정 결과 산출에만 쓰고, 이 상태의 화면값으로 절대 내보내지 않는다.
export const MASKED_CREW_WEEKLY_METRICS: CrewWeeklyMetrics = {
  memberCount: null,
  seasonRestCount: null,
  personalRestCount: null,
  growthChallengeCount: null,
  growthSuccessCount: null,
  growthFailureCount: null,
  growthSuccessRatePercent: null,
  growthChallengeRatePercent: null,
};

type ProfileRow = {
  user_id: string;
  status: string | null;
  current_team_name: string | null;
  activity_started_at: string | null;
  // 공표 snapshot 에 **값으로 복사**할 표시/식별 필드(이후 개명·소속 이동에 불변이어야 함).
  display_name: string | null;
  crew_code: string | null;
  current_part_name: string | null;
};

export type CrewWeeklyMetricsInputs = {
  /** 로스터(테스트 스코프·졸업·운영진 제외 후). 시즌 휴식자는 **남겨둔다**(분리 집계). */
  roster: ProfileRow[];
  /** user_id → effectiveStart(YYYY-MM-DD). 없으면 activity_started_at 사용. */
  memberStartByUser: Map<string, string>;
  /** 개인 휴식 기간(조직 스코프). */
  restPeriods: Array<{ user_id: string; start_date: string; end_date: string }>;
  /** `${user_id}|${week_start_date}` → uws.status */
  statusByUserWeek: Map<string, string>;
  /** week_start_date → 보정 성공수(weekly_league_success_overrides). */
  successOverrideByWeekStart: Map<string, number>;
  /** `${user_id}|${season_key}` — 그 시즌 휴식(user_season_statuses.status='rest') 인원. */
  seasonRestByUserSeason: Set<string>;
  /** user_id → 프로필(표시명/크루코드/팀·파트). 공표 snapshot 복사용. */
  profileById: Map<string, ProfileRow>;
  /**
   * 원천별 로드 성공 여부. **집계 미완료(-)와 실제 0을 구분**하기 위한 근거다.
   *   조회가 실패하면 그 원천에 의존하는 지표는 0 이 아니라 null(=화면 "-")이 되어야 한다.
   */
  sourcesLoaded: {
    roster: boolean;
    seasonRest: boolean;
    personalRest: boolean;
    uws: boolean;
  };
};

// 조직 1개의 지표 입력 일괄 로드. 주차 루프 밖에서 1회만 호출한다(N+1 방지).
export async function loadCrewWeeklyMetricsInputs(
  organization: OrganizationSlug,
  /**
   * ⚠ raw mode 를 받지 않는다. 반드시 검수 상태와 **동일한** resolveOrgResultScope 결과를 넘긴다.
   *   (2026-07-22 버그: raw mode 를 쓰는 바람에 QA_HIDE_REAL_USERS=true 인데도 지표만 실사용자를
   *    읽어, 한 행에서 검수 상태=test 코호트 / 지표=operating 코호트가 섞였다.)
   */
  scope: OrgResultScope,
): Promise<CrewWeeklyMetricsInputs> {
  const isTestMode = scope === "test";

  const [{ data: profiles, error: profilesErr }, testIds, { data: operators }] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,status,current_team_name,current_part_name,activity_started_at,display_name,crew_code")
      .eq("organization_slug", organization)
      .in("status", ROSTER_STATUSES),
    fetchTestUserMarkerIds(),
    supabaseAdmin
      .from("operator_markers")
      .select("user_id")
      .eq("organization_slug", organization),
  ]);

  const operatorIds = new Set((operators ?? []).map((o) => (o as { user_id: string }).user_id));

  // front 필터와 동일 순서/의미. 단 '시즌전체휴식'은 **제외하지 않고 남긴다**(seasonRest 로 분리 집계).
  const roster = ((profiles ?? []) as ProfileRow[]).filter((p) => {
    const isTest = testIds.has(p.user_id);
    if (isTestMode ? !isTest : isTest) return false; // 스코프 게이트
    if (p.status === "graduated") return false; // PMS 졸업 제외
    if (operatorIds.has(p.user_id)) return false; // PMS 운영진 제외
    // PMS 휴면 명부 제외 — front 와 동일. 시즌 휴식(seasonRest)은 이 신호가 아니라
    //   user_season_statuses 로 따로 센다(위 주석 참조).
    if (p.current_team_name === SEASON_REST_TEAM_NAME) return false;
    return true;
  });

  const userIds = roster.map((p) => p.user_id);
  const memberStartByUser = new Map<string, string>();
  const restPeriods: Array<{ user_id: string; start_date: string; end_date: string }> = [];
  const statusByUserWeek = new Map<string, string>();
  const successOverrideByWeekStart = new Map<string, number>();
  const seasonRestByUserSeason = new Set<string>();
  const profileById = new Map<string, ProfileRow>(roster.map((p) => [p.user_id, p]));
  const rosterLoaded = !profilesErr;

  if (userIds.length === 0) {
    return {
      roster, memberStartByUser, restPeriods, statusByUserWeek, successOverrideByWeekStart,
      seasonRestByUserSeason, profileById,
      sourcesLoaded: { roster: rosterLoaded, seasonRest: true, personalRest: true, uws: true },
    };
  }

  const [msRes, rpRes, uwsRes, ovRes, srRes] = await Promise.all([
    supabaseAdmin
      .from("weekly_league_member_start")
      .select("user_id,member_start_date")
      .eq("organization_slug", organization),
    supabaseAdmin
      .from("crew_personal_rest_periods")
      .select("user_id,start_date,end_date")
      .eq("organization_slug", organization),
    // ⚠ PostgREST range 페이지네이션은 안정 정렬 없이 1000행을 넘기면 중복/누락이 난다
    //   (front 와 동일 주의 — [[project_cluster4-postgrest-cap-and-v14-1]]). 전량 페이징 + 정렬.
    selectAllUws(userIds),
    supabaseAdmin
      .from("weekly_league_success_overrides")
      .select("week_start_date,growth_success")
      .eq("organization_slug", organization),
    // 시즌 휴식 SoT — 시즌 단위 상태. 주차는 자기 season_key 로 조회한다.
    supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,season_key")
      .eq("status", "rest")
      .in("user_id", userIds),
  ]);

  if (!msRes.error) {
    for (const r of (msRes.data ?? []) as Array<{ user_id: string; member_start_date: string }>) {
      memberStartByUser.set(r.user_id, r.member_start_date);
    }
  }
  if (!rpRes.error) {
    restPeriods.push(...((rpRes.data ?? []) as typeof restPeriods));
  }
  for (const r of uwsRes.rows) {
    statusByUserWeek.set(`${r.user_id}|${r.week_start_date}`, r.status);
  }
  const uwsOk = uwsRes.ok;
  if (!ovRes.error) {
    for (const r of (ovRes.data ?? []) as Array<{ week_start_date: string; growth_success: number }>) {
      successOverrideByWeekStart.set(r.week_start_date, Number(r.growth_success));
    }
  }

  if (!srRes.error) {
    for (const r of (srRes.data ?? []) as Array<{ user_id: string; season_key: string }>) {
      seasonRestByUserSeason.add(`${r.user_id}|${r.season_key}`);
    }
  }

  return {
    roster, memberStartByUser, restPeriods, statusByUserWeek, successOverrideByWeekStart,
    seasonRestByUserSeason, profileById,
    sourcesLoaded: {
      roster: rosterLoaded,
      seasonRest: !srRes.error,
      personalRest: !rpRes.error,
      uws: uwsOk,
    },
  };
}

// uws 전량 페이징(안정 정렬 필수).
async function selectAllUws(
  userIds: string[],
): Promise<{ ok: boolean; rows: Array<{ user_id: string; week_start_date: string; status: string }> }> {
  const out: Array<{ user_id: string; week_start_date: string; status: string }> = [];
  let ok = true;
  const PAGE = 1000;
  for (let i = 0; i < userIds.length; i += 300) {
    const slice = userIds.slice(i, i + 300);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,week_start_date,status")
        .in("user_id", slice)
        .order("user_id", { ascending: true })
        .order("week_start_date", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.warn("[crew-week-results] uws 조회 실패", error.message);
        ok = false;
        break;
      }
      const rows = (data ?? []) as typeof out;
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
  }
  return { ok, rows: out };
}

// 주차 1개의 지표 산출 — **순수 함수**(DB/시계 접근 없음). front 918~945행 미러.
export function computeCrewWeeklyMetrics(opts: {
  inputs: CrewWeeklyMetricsInputs;
  weekStartDate: string;
  weekEndDate: string;
  /** 그 주차가 속한 시즌(weeks.season_key) — 시즌 휴식 판정용. */
  seasonKey: string | null;
  isOfficialRest: boolean;
}): CrewWeeklyMetrics {
  // 공식 휴식 주차 = 전 지표 하드 0(front 875~897행과 동일. '-' 아님).
  if (opts.isOfficialRest) return { ...EMPTY_CREW_WEEKLY_METRICS };

  const { inputs, weekStartDate, weekEndDate, seasonKey } = opts;

  const restUserIds = new Set(
    inputs.restPeriods
      .filter((r) => r.start_date <= weekEndDate && r.end_date >= weekStartDate)
      .map((r) => r.user_id),
  );

  let seasonRest = 0;
  let personalRest = 0;
  let growthSuccess = 0;
  let growthFail = 0;

  for (const p of inputs.roster) {
    const started = inputs.memberStartByUser.get(p.user_id) ?? p.activity_started_at ?? null;
    // 미시작(StartDate > 주차 종료) 제외 — front 와 동일.
    if (!started || started.slice(0, 10) > weekEndDate) continue;

    // 시즌 휴식 — 그 주차가 속한 시즌의 user_season_statuses.status='rest'.
    //   개인 휴식보다 우선(시즌 전체를 쉬는 사람은 개인 휴식으로 중복 계상하지 않는다).
    if (seasonKey && inputs.seasonRestByUserSeason.has(`${p.user_id}|${seasonKey}`)) {
      seasonRest++;
      continue;
    }
    if (restUserIds.has(p.user_id)) {
      personalRest++;
      continue;
    }
    // 성공 = uws.status==='success'. 그 외(fail/기타/행 없음) 전부 실패 — 차감 계산이 아니다.
    if (inputs.statusByUserWeek.get(`${p.user_id}|${weekStartDate}`) === "success") growthSuccess++;
    else growthFail++;
  }

  // PMS 실측 성공수 보정 — total/rest 불변, success/fail split 만(front 931~938행).
  const ov = inputs.successOverrideByWeekStart.get(weekStartDate);
  if (ov != null) {
    const nonRest = growthSuccess + growthFail;
    growthSuccess = Math.min(ov, nonRest);
    growthFail = nonRest - growthSuccess;
  }

  const growthChallenge = growthSuccess + growthFail;
  // 소속 크루 = 시즌 휴식 + 개인 휴식 + 성장 도전 (고객 UI WeeklyDetailContent 가 선언한 등식).
  const memberCount = seasonRest + personalRest + growthChallenge;

  return {
    memberCount,
    seasonRestCount: seasonRest,
    personalRestCount: personalRest,
    growthChallengeCount: growthChallenge,
    growthSuccessCount: growthSuccess,
    growthFailureCount: growthFail,
    // 분모 0 → 0(고객 앱과 동일 — '-' 아님). Math.round 도 동일.
    growthSuccessRatePercent:
      growthChallenge > 0 ? Math.round((growthSuccess / growthChallenge) * 100) : 0,
    growthChallengeRatePercent:
      memberCount > 0 ? Math.round((growthChallenge / memberCount) * 100) : 0,
  };
}
