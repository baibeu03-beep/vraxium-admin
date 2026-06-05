import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { EXPERIENCE_RATING_FAIL_THRESHOLD } from "@/lib/cluster4Enhancement";
import { isCareerGradeFail, type CareerGrade } from "@/lib/careerGrade";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import { getGrowthIndicators } from "@/lib/cluster3GrowthData";
import {
  RESUME_BADGE_BY_GROWTH_STATUS,
  type GrowthStatusKey,
} from "@/shared/growth.contracts";
import type {
  Cluster1ResumeDto,
  ResumeStatus,
  ScheduleReliability,
  ActivityCompletion,
  SeasonRecord,
  PracticalStats,
  PositionLabel,
} from "@/lib/cluster1ResumeTypes";

// ─────────────────────────────────────────────────────────────────────
// Resume badge: Growth Core 의 성장 상태(GrowthStatusKey) 기준 (user_profiles.status 미사용).
//   10종 상태 → 5종 뱃지 매핑은 shared/growth.contracts.RESUME_BADGE_BY_GROWTH_STATUS 단일 출처.
//   (구 STATUS_MAP/user_profiles.status 기반 판정은 제거 — growth_status≠status 불일치로
//    잘못된 뱃지가 나오던 문제 해소.)
// ─────────────────────────────────────────────────────────────────────
function resolveResumeStatusFromGrowthKey(key: GrowthStatusKey): ResumeStatus {
  const spec = RESUME_BADGE_BY_GROWTH_STATUS[key];
  return {
    status: spec.code,
    label: spec.label,
    isBadgeDimmed: spec.isBadgeDimmed,
  };
}

// growth 지표 조회 실패/미상 시 기본 뱃지(활동 중단 계열).
const DEFAULT_RESUME_STATUS: ResumeStatus = {
  status: "next_challenge",
  label: "Next Challenge",
  isBadgeDimmed: true,
};

// ─────────────────────────────────────────────────────────────────────
// Schedule Reliability computation
//   a = 가입 이후 물리적 주차, b = 사전 휴식 신청, c = 미인정 활동,
//   d = 인정 활동, e = 공식 휴식
//   rate = ((d + b) / (a - e)) * 100
// ─────────────────────────────────────────────────────────────────────
async function computeScheduleReliability(
  userId: string,
): Promise<ScheduleReliability> {
  const [weekRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from("user_week_statuses")
      .select("week_start_date,status")
      .eq("user_id", userId),
    supabaseAdmin
      .from("user_profiles")
      .select("activity_started_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  if (weekRes.error || !weekRes.data || profileRes.error) {
    return dummyScheduleReliability();
  }

  const activityStart = profileRes.data?.activity_started_at as
    | string
    | null;
  if (!activityStart) return dummyScheduleReliability();

  const startDate = new Date(activityStart);
  const now = new Date();
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const physicalWeeks = Math.max(
    1,
    Math.floor((now.getTime() - startDate.getTime()) / msPerWeek),
  );

  const rows = weekRes.data as Array<{
    week_start_date: string | null;
    status: string;
  }>;
  let preRestWeeks = 0;
  let unapprovedActiveWeeks = 0;
  let approvedActiveWeeks = 0;
  let officialRestWeeks = 0;
  let transitionWeeks = 0;

  for (const row of rows) {
    // 전환 주차는 신뢰율 분자·분모 모두에서 제외(공식 휴식 아님). 분모 보정용으로만 카운트.
    if (row.week_start_date && isTransitionWeekStart(row.week_start_date)) {
      transitionWeeks++;
      continue;
    }
    switch (row.status) {
      case "success":
        approvedActiveWeeks++;
        break;
      case "fail":
        unapprovedActiveWeeks++;
        break;
      case "personal_rest":
        preRestWeeks++;
        break;
      case "official_rest":
        officialRestWeeks++;
        break;
    }
  }

  // physicalWeeks(시간기반 분모)에서 공식 휴식 + 전환 주차를 제외.
  const denominator = physicalWeeks - officialRestWeeks - transitionWeeks;
  const rate =
    denominator > 0
      ? Math.round(((approvedActiveWeeks + preRestWeeks) / denominator) * 100)
      : 0;

  return {
    physicalWeeks,
    preRestWeeks,
    unapprovedActiveWeeks,
    approvedActiveWeeks,
    officialRestWeeks,
    rate,
  };
}

function dummyScheduleReliability(): ScheduleReliability {
  return {
    physicalWeeks: 35,
    preRestWeeks: 2,
    unapprovedActiveWeeks: 1,
    approvedActiveWeeks: 30,
    officialRestWeeks: 3,
    rate: 94,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Activity Completion — 단일 SoT = 허브 weekly-cards 카드(area-6/area-7 과 동일).
//
//   활동 완료율 = (전체 기간 이행 라인 수) / (전체 기간 개설된 모든 라인 수) × 100
//
//   분자(completedActivities) = Σ card.growthNumerator   (= 이행 라인 = weeklyGrowth.completedLines)
//   분모(availableActivities) = Σ card.growthDenominator (= 개설된 모든 라인 = weeklyGrowth.availableLines)
//
//   growthDenominator 는 "개설된(any-target) 모든 distinct 라인"(info/exp/competency, synthetic
//   fail 포함) + career 본인배정 으로, 허브 강화율 분모 정의와 1:1 동일하다
//   (lib/cluster4SeasonCircles.computeSeasonAreaProgress / computeAreaSixCircles 와 같은 source).
//   전환 주차(isTransition)만 제외 — 휴식 주차는 카드 단계에서 denominator=0 이라 자연 제외된다.
//   현재 시즌만 보는 area-6 와 달리 "전체 활동 기간"을 위해 모든 시즌 카드를 합산한다.
//   별도 라인 재집계 없이 카드 파생값을 그대로 합산하므로 허브 화면과 항상 같은 값이 나온다.
// ─────────────────────────────────────────────────────────────────────
async function computeActivityCompletion(
  userId: string,
): Promise<ActivityCompletion> {
  let cards: Cluster4WeeklyCardDto[];
  try {
    cards = await getCluster4WeeklyCardsForProfileUser(userId);
  } catch {
    return { availableActivities: 0, completedActivities: 0, rate: 0 };
  }

  let availableActivities = 0;
  let completedActivities = 0;
  for (const card of cards) {
    if (card.isTransition) continue; // 전환 주차 제외 (area-6/7 과 동일 범위)
    availableActivities += card.growthDenominator;
    completedActivities += card.growthNumerator;
  }

  // 허브(roundGrowthRate / pct)와 동일한 정수 반올림. available 0 → 0.
  const rate =
    availableActivities > 0
      ? Math.round((completedActivities / availableActivities) * 100)
      : 0;

  return { availableActivities, completedActivities, rate };
}

// ─────────────────────────────────────────────────────────────────────
// Season Records — season_definitions + user_week_statuses
// ─────────────────────────────────────────────────────────────────────
const POSITION_RANK: Record<string, number> = {
  "운영진(클럽장)": 6,
  "운영진(앰배서더)": 5,
  "운영진(팀장)": 4,
  "심화(파트장)": 3,
  "심화(에이전트)": 2,
  "일반(정규)": 1,
};

const SEASON_LABEL_MAP: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

// 시즌 타입별 정규 주차 수(전환 주차 제외) — lib/seasonCalendar CHAIN 과 동일 고정값.
const SEASON_TOTAL_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

// KST(UTC+9) 기준 오늘 날짜 문자열 "YYYY-MM-DD". 시즌 검수 경계는 날짜 단위라
// 서버 타임존(UTC)·시각(00:00 등)에 흔들리지 않도록 KST 달력일로 환산해 비교한다.
function kstDateString(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// "YYYY-MM-DD" + n일 → "YYYY-MM-DD". UTC 자정 기준 달력일 가산(시/분/타임존 무관).
function addCalendarDays(dateStr: string, days: number): string {
  const ms = Date.UTC(
    +dateStr.slice(0, 4),
    +dateStr.slice(5, 7) - 1,
    +dateStr.slice(8, 10),
  );
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

async function computeSeasonRecords(
  userId: string,
): Promise<SeasonRecord[]> {
  const [seasonRes, weekRes, weeksPubRes] = await Promise.all([
    supabaseAdmin
      .from("season_definitions")
      .select("season_key,season_label,season_type,start_date,end_date")
      .order("start_date", { ascending: false }),
    supabaseAdmin
      .from("user_week_statuses")
      .select("year,week_number,status,season_key,week_start_date")
      .eq("user_id", userId),
    // 공표 여부(weeks.result_published_at) — approvedWeeks(시즌 줄 분자)는 공표 완료
    // 성공 주차만 센다 (2026-06-05 통일: cluster4 accumulatedApprovedWeeks·medal-week-num
    // 과 동일 기준 — 미공표/검수중 주차는 success 라도 제외).
    supabaseAdmin.from("weeks").select("start_date,result_published_at"),
  ]);

  if (seasonRes.error || !seasonRes.data || weekRes.error || !weekRes.data) {
    return dummySeasonRecords();
  }

  // 주차 시작일 → 공표 완료 여부. weeks 행이 없는 과거(공표 개념 도입 전) 주차는 공표
  // 완료로 간주 — getWeeklyGrowth 의 synthetic isWeekPublished=true 규칙과 동일(표시 보존).
  // weeks 조회 실패 시에도 동일 폴백(전부 공표 취급) — 분자 과소 방지(기존 동작 보존).
  const publishedByStart = new Map<string, boolean>();
  for (const w of (weeksPubRes.data ?? []) as {
    start_date: string | null;
    result_published_at: string | null;
  }[]) {
    if (w.start_date) publishedByStart.set(w.start_date, Boolean(w.result_published_at));
  }
  const isPublishedStart = (start: string | null): boolean => {
    if (!start) return true;
    return publishedByStart.get(start) ?? true;
  };

  type SeasonDef = {
    season_key: string;
    season_label: string;
    season_type: string;
    start_date: string;
    end_date: string;
  };
  type WeekRow = {
    year: number;
    week_number: number;
    status: string;
    season_key: string | null;
    week_start_date: string | null;
  };

  const seasons = seasonRes.data as SeasonDef[];
  const weeks = weekRes.data as WeekRow[];

  if (seasons.length === 0) return dummySeasonRecords();

  const weeksBySeason = new Map<string, WeekRow[]>();
  for (const w of weeks) {
    const key = w.season_key;
    if (!key) continue;
    // 전환 주차는 활동 주차 수·총 주차 수·진행 상태 판정 모두에서 제외
    // (computeScheduleReliability 와 동일 규칙 — 전환 주차는 시즌 정규 주차가 아님).
    if (w.week_start_date && isTransitionWeekStart(w.week_start_date)) continue;
    const arr = weeksBySeason.get(key) ?? [];
    arr.push(w);
    weeksBySeason.set(key, arr);
  }

  // 시즌 직책 = 등급 SoT(user_memberships.membership_level, is_current 우선) + role 보조.
  // role 은 "심화" 등급 내 파트장/에이전트 구분과 운영진 표기에만 쓴다(단독 사용 금지).
  const [membershipRes, profileRoleRes] = await Promise.all([
    supabaseAdmin
      .from("user_memberships")
      .select("membership_level,is_current,created_at,updated_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("user_profiles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  const profileRole =
    ((profileRoleRes.data as { role: string | null } | null)?.role ?? null);

  const records: SeasonRecord[] = [];

  for (const season of seasons) {
    const seasonWeeks = weeksBySeason.get(season.season_key);
    if (!seasonWeeks || seasonWeeks.length === 0) continue;

    // 총 주차 수 = 시즌 타입별 고정값(봄/가을 16 · 여름/겨울 8, seasonCalendar CHAIN 과 동일).
    // 종전에는 user_week_statuses 행 개수를 그대로 써서 전환 주차 포함 시 "4주 / 9주"처럼
    // 분모가 부풀었다. 미정의 season_type 만 전환 제외 행 수로 폴백.
    const totalWeeks =
      SEASON_TOTAL_WEEKS[season.season_type] ?? seasonWeeks.length;
    // 분자 = "공표 완료된" 성공 주차만 (2026-06-05 통일). 미공표(집계 중/검수중) 주차는
    // success 상태가 있어도 제외 — cluster4 누적·medal-week-num 과 동일 기준.
    const approvedWeeks = seasonWeeks.filter(
      (w) => w.status === "success" && isPublishedStart(w.week_start_date),
    ).length;

    const now = new Date();
    // progressStatus "진행 중" 판정은 기존 동작 보존(시즌 종료일 timestamp 기준).
    const isOngoing = now <= new Date(season.end_date);

    let progressStatus: SeasonRecord["progressStatus"];
    const hasRest = seasonWeeks.some((w) => w.status === "personal_rest");
    const hasFail = seasonWeeks.some((w) => w.status === "fail");

    if (isOngoing) {
      progressStatus = "진행 중";
    } else if (hasRest && !hasFail) {
      progressStatus = "통합 휴식";
    } else if (hasFail && approvedWeeks < totalWeeks / 2) {
      progressStatus = "활동 중단";
    } else {
      progressStatus = approvedWeeks >= totalWeeks - 1
        ? "정상 졸업"
        : "정상 완료";
    }

    // 시즌 검수 상태 — KST date-only 경계(UTC timestamp 비교 금지).
    //   시작 후 ~ 종료 후 14일째(포함)까지 "검수 중", 15일째부터 "승인 완료".
    //   end_date(KST 달력일) + 14일을 포함 상한으로 두고 오늘(KST) 날짜와 비교한다.
    //   end_date 를 new Date 로 UTC 자정 비교하면 14일째 00:00 직후 승인 완료로
    //   빠지는 off-by-one 이 생기므로 날짜 문자열 비교로 처리한다.
    const todayKst = kstDateString(now);
    const reviewCutoff = addCalendarDays(season.end_date.slice(0, 10), 14);
    const reviewStatus: SeasonRecord["reviewStatus"] =
      todayKst <= reviewCutoff ? "검수 중" : "승인 완료";

    const yearStr = season.season_key.slice(2, 4);
    const seasonName =
      SEASON_LABEL_MAP[season.season_type] ?? season.season_label;

    const position = resolvePosition(membershipRes.data ?? [], profileRole);

    records.push({
      year: yearStr,
      seasonName,
      position,
      progressStatus,
      approvedWeeks,
      totalWeeks,
      reviewStatus,
    });
  }

  return records.length > 0 ? records : dummySeasonRecords();
}

// 등급 SoT = membership_level("일반"/"심화"), role 은 보조 (2026-06-04 통일 —
// /admin/members memberStatusLabel · cluster4 buildActivityLabels 와 동일 정책).
//   - 운영진 role(team_leader/ambassador) → 등급 체계 밖, 운영진 라벨 (기존 정책 유지)
//   - 심화 + part_leader → "심화(파트장)" / 심화 + 그 외 role → "심화(에이전트)"
//   - 일반(또는 등급 미보유/미확정) → "일반(정규)" — role 단독으로 직책을 만들지 않는다.
// 종전 구현은 POSITION_RANK 의 풀라벨 키("심화(파트장)" 등)만 인정해 실제 DB 값
// "심화"가 전부 "일반(정규)"으로 떨어지는 결함이 있었다(심화 멤버 전원 오표기).
function resolvePosition(
  memberships: Array<Record<string, unknown>>,
  role: string | null,
): PositionLabel {
  if (role === "team_leader") return "운영진(팀장)";
  if (role === "ambassador") return "운영진(앰배서더)";

  // is_current=true 행 우선, 없으면 최신(created_at desc 정렬) 첫 행.
  const current =
    memberships.find((m) => Boolean(m.is_current)) ?? memberships[0];
  const level = ((current?.membership_level as string | null) ?? "").trim();

  // 레거시 풀라벨("심화(파트장)" 등)이 저장돼 있으면 그대로 인정 (하위 호환).
  if (level in POSITION_RANK) return level as PositionLabel;

  if (level.startsWith("심화")) {
    return role === "part_leader" ? "심화(파트장)" : "심화(에이전트)";
  }
  return "일반(정규)";
}

function dummySeasonRecords(): SeasonRecord[] {
  return [
    {
      year: "25",
      seasonName: "여름 시즌",
      position: "심화(에이전트)",
      progressStatus: "진행 중",
      approvedWeeks: 7,
      totalWeeks: 8,
      reviewStatus: "검수 중",
    },
    {
      year: "25",
      seasonName: "봄 시즌",
      position: "일반(정규)",
      progressStatus: "정상 완료",
      approvedWeeks: 11,
      totalWeeks: 12,
      reviewStatus: "승인 완료",
    },
    {
      year: "24",
      seasonName: "겨울 시즌",
      position: "일반(정규)",
      progressStatus: "정상 졸업",
      approvedWeeks: 12,
      totalWeeks: 12,
      reviewStatus: "승인 완료",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Practical Stats — "공표 완료된 강화 성공 결과"만 카운트 (2026-06-05 정책 확정).
//   이력서 = 공표 완료 확정 성과 / 허브 weekly-cards = 실시간·검수 현황 으로 도메인 분리 —
//   허브 식(fetchWeeklyCardLineAggregates)과 일부러 다르다. 허브·snapshot·uws 는 불변.
//
//   4개 공통 규칙:
//     ① 공표 필터: weeks.result_published_at 있는 주차만 (미공표/검수중 제외).
//     ② 강화 성공만: 마감(submission_closes_at) 지난 본인 user target 중 success 만.
//        - info/competency: 마감 = success (평가 체계 없음 — 허브와 동일 기준).
//        - experience: rating ≥ 4 만. rating ≤ 3(강화 실패)·미평가 제외
//          (허브는 미평가=success 로 치지만 이력서는 "평가 확정" 전엔 카운트하지 않는다).
//        - career: grade S/A/B/C 만. D(강화 실패)·미평가 제외.
//     ③ 주차 fold: 같은 주차에 success 가 여러 개여도 part 당 1 unit
//        (카드 v14 의 주차 1칸 fold 기준과 동일 — 값 = "공표 완료된 강화 성공 주차 수").
//   user_activity_details / career_records 미사용(legacy 동결). 제출 여부 무관.
// ─────────────────────────────────────────────────────────────────────
async function computePracticalStats(
  userId: string,
  now: number = Date.now(),
): Promise<PracticalStats> {
  const empty: PracticalStats = {
    infoCount: 0,
    experienceCount: 0,
    abilityUnitCount: 0,
    careerProjectCount: 0,
  };

  const weekRes = await supabaseAdmin
    .from("user_week_statuses")
    .select("week_start_date")
    .eq("user_id", userId);
  const startDates = ((weekRes.data ?? []) as { week_start_date: string }[]).map(
    (w) => w.week_start_date,
  );
  if (startDates.length === 0) return empty;

  // ① 공표 완료 주차만. weeks 행이 없는 start_date 는 week_id 가 없어 target 도 없으므로
  //   자연 제외(폴백 불필요 — seasonRecords 의 "weeks 행 없음=공표 간주"와 결과 동일).
  const { data: weeksData } = await supabaseAdmin
    .from("weeks")
    .select("id,result_published_at")
    .in("start_date", startDates);
  const publishedWeekIds = ((weeksData ?? []) as {
    id: string;
    result_published_at: string | null;
  }[])
    .filter((w) => Boolean(w.result_published_at))
    .map((w) => w.id);
  if (publishedWeekIds.length === 0) return empty;

  // 본인 user target (공표 주차 한정). 유저+주차로 한정되어 행 수가 작다(1000행 cap 무관).
  const { data: targetRows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,week_id,line_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("week_id", publishedWeekIds);
  const targets = (targetRows ?? []) as { id: string; week_id: string; line_id: string }[];
  if (targets.length === 0) return empty;

  // active 라인만 (part_type + 마감). 비활성 라인 target 은 자동 제외.
  const targetLineIds = [...new Set(targets.map((t) => t.line_id))];
  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,submission_closes_at")
    .in("id", targetLineIds)
    .eq("is_active", true);
  const lineById = new Map(
    ((lineRows ?? []) as {
      id: string;
      part_type: string;
      submission_closes_at: string | null;
    }[]).map((l) => [l.id, l]),
  );

  // ② 마감 지난 target 분류. experience/career 는 평가 조회 후 success 확정.
  const infoWeeks = new Set<string>();
  const abilityWeeks = new Set<string>();
  const experienceCandidates: { id: string; week_id: string }[] = [];
  const careerCandidates: { id: string; week_id: string }[] = [];
  for (const t of targets) {
    const line = lineById.get(t.line_id);
    if (!line) continue;
    const deadlinePassed =
      Boolean(line.submission_closes_at) &&
      new Date(line.submission_closes_at as string).getTime() < now;
    if (!deadlinePassed) continue;
    switch (line.part_type) {
      case "info":
        infoWeeks.add(t.week_id);
        break;
      case "competency":
        abilityWeeks.add(t.week_id);
        break;
      case "experience":
        experienceCandidates.push({ id: t.id, week_id: t.week_id });
        break;
      case "career":
        careerCandidates.push({ id: t.id, week_id: t.week_id });
        break;
    }
  }

  // experience: rating ≥ 4 만 success (미평가·rating≤3 제외).
  const experienceWeeks = new Set<string>();
  if (experienceCandidates.length > 0) {
    const { data: expEvals } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,rating")
      .eq("user_id", userId)
      .in("line_target_id", experienceCandidates.map((t) => t.id));
    const ratingByTarget = new Map<string, number>();
    for (const e of (expEvals ?? []) as { line_target_id: string; rating: number }[]) {
      ratingByTarget.set(e.line_target_id, e.rating);
    }
    for (const t of experienceCandidates) {
      const rating = ratingByTarget.get(t.id);
      if (rating != null && rating > EXPERIENCE_RATING_FAIL_THRESHOLD) {
        experienceWeeks.add(t.week_id);
      }
    }
  }

  // career: grade S/A/B/C 만 success (미평가·D 제외).
  const careerWeeks = new Set<string>();
  if (careerCandidates.length > 0) {
    const { data: evals } = await supabaseAdmin
      .from("cluster4_career_line_evaluations")
      .select("line_target_id,grade")
      .eq("user_id", userId)
      .in("line_target_id", careerCandidates.map((t) => t.id));
    const gradeByTarget = new Map<string, CareerGrade>();
    for (const e of (evals ?? []) as { line_target_id: string; grade: CareerGrade }[]) {
      gradeByTarget.set(e.line_target_id, e.grade);
    }
    for (const t of careerCandidates) {
      const grade = gradeByTarget.get(t.id);
      if (grade && !isCareerGradeFail(grade)) careerWeeks.add(t.week_id);
    }
  }

  // ③ 주차 fold — Set 크기 = part 당 성공 주차 수.
  return {
    infoCount: infoWeeks.size,
    experienceCount: experienceWeeks.size,
    abilityUnitCount: abilityWeeks.size,
    careerProjectCount: careerWeeks.size,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Main: Cluster1 Resume DTO
// ─────────────────────────────────────────────────────────────────────
export async function getCluster1Resume(
  legacyUserId: string,
): Promise<Cluster1ResumeDto | null> {
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return null;

  const userId = crew.userId;

  if (!userId) {
    return {
      resumeStatus: DEFAULT_RESUME_STATUS,
      scheduleReliability: dummyScheduleReliability(),
      activityCompletion: { availableActivities: 0, completedActivities: 0, rate: 0 },
      seasonRecords: dummySeasonRecords(),
      practicalStats: { infoCount: 0, experienceCount: 0, abilityUnitCount: 0, careerProjectCount: 0 },
    };
  }

  const [scheduleReliability, seasonRecords, activityCompletion, practicalStats, growth] =
    await Promise.all([
      computeScheduleReliability(userId),
      computeSeasonRecords(userId),
      computeActivityCompletion(userId),
      computePracticalStats(userId),
      // resume 뱃지 = Growth Core 의 성장 상태(GrowthStatusKey) 기준. 실패 시 기본 뱃지로 폴백.
      getGrowthIndicators(userId).catch((e) => {
        console.warn("[cluster1] resume badge growth resolve failed → default", {
          userId,
          message: e instanceof Error ? e.message : String(e),
        });
        return null;
      }),
    ]);

  const resumeStatus = growth
    ? resolveResumeStatusFromGrowthKey(
        growth.process.growthDisplayKey as GrowthStatusKey,
      )
    : DEFAULT_RESUME_STATUS;

  return {
    resumeStatus,
    scheduleReliability,
    activityCompletion,
    seasonRecords,
    practicalStats,
  };
}
