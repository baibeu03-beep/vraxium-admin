import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { lazyEnsureCrewCode } from "@/lib/adminCrewCodeData";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { statusBucket, statusBucketLabel } from "@/lib/memberStatusBucket";
import { classLabel } from "@/lib/adminMembersTypes";
import { isTestUser as isMarkedTestUser } from "@/lib/testUsers";
import { sumPointsForUsers } from "@/lib/adminMembersData";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { getCrewSeasonResults, type CrewSeasonResultRow } from "@/lib/adminCrewSeasonResults";
import { getCrewWeeklyResults, type CrewWeeklyResultRow } from "@/lib/adminCrewWeeklyResults";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { foldGrowthMetrics } from "@/lib/growthCore";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// 크루 상세 페이지(/admin/members/[userId]) 단건 DTO — 인적사항 + 클럽 소속.
// ──────────────────────────────────────────────────────────────────────────
//   · 프론트는 임의 계산하지 않는다 — 표시값(상태/활동 시작·종료일·주차/대표 학력/크루 코드/클래스 등)을
//     모두 백엔드에서 확정해 내려준다.
//   · 프로필 사진 = user_profiles.profile_photo_url(Cluster2 사진 첫 번째 슬롯=sidebar, 고객앱 동일 SoT).
//   · 대표 학력 = user_educations 의 is_primary(=sort_order 0) 행(고객앱 /api/educations 동일 선택).
//   · 상태 = 표시 성장상태(getGrowthRosterBatchFast) → 버킷 라벨(목록 표와 동일 SoT).
//   · 활동 주차 기준 = weeks(월요일 start_date ~ 일요일 end_date). 시작=시작일 포함 주차의 월요일,
//     종료=종료일 포함 주차의 일요일. 종료는 상태가 엘리트/활동 중단일 때만 존재.
//   · 클럽 결과(종합) = clubSummary. 프론트는 새로 계산하지 않고 백엔드가 동일 SoT 값을 내려준다.
//       - successWeeks/poA·B·C  : /admin/members 표 A 와 동일 SoT(getGrowthRosterBatchFast·sumPointsForUsers)
//       - scheduleReliability/activityCompletion : 고객 cluster.1 = getCluster1Resume 동일 산식(rate %)
//       - info/experience/abilityUnit/careerProject : 고객 이력서 카드 skill-num = practicalStats 그대로
//         (별도 재계산 금지 — getCluster1Resume 단일 SoT 직결로 카드 값과 항상 일치).
//   · snapshot/포인트 무접촉(읽기 전용 — 크루 코드 lazy 생성만 user_profiles.crew_code write, freeze).
// ──────────────────────────────────────────────────────────────────────────

const SEASON_TYPE_KO: Record<string, string> = {
  winter: "겨울",
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
};

type WeekRow = {
  id: string;
  start_date: string | null;
  end_date: string | null;
  season_key: string | null;
  week_number: number | null;
};

type EducationRow = {
  school_name: string | null;
  major_name_1: string | null;
  admission_year: string | number | null;
  admission_month: string | null;
  sort_order: number | null;
  is_primary: boolean | null;
  updated_at: string | null;
};

type ProfileExtraRow = {
  address: string | null;
  activity_started_at: string | null;
  activity_ended_at: string | null;
  suspended_week_id: string | null;
  // 시즌 종료/시작 판정용(고객 /api/profile growthInfo 와 동일하게 raw 컬럼 사용).
  growth_status: string | null;
  status: string | null;
};

type SeasonStatusRow = {
  status: string;
  season_key: string | null;
};

export type CrewDetailData = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  // 테스트 유저 여부(test_user_markers SoT). 커리어레쥬메 이동 시 demoUserId+mode=test(테스트)
  // vs userId(운영) 분기에 사용 — 일반 크루에 "테스트 유저 모드" 배너가 뜨지 않게 한다.
  isTestUser: boolean;
  // 인적사항
  profilePhotoUrl: string | null; // Cluster2 사진 첫 번째 슬롯(profile_photo_url)
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  address: string | null; // 거주지
  contactPhone: string | null;
  contactEmail: string | null;
  schoolName: string | null; // 대표 학력 — 학교
  departmentName: string | null; // 대표 학력 — 전공
  admissionPeriod: string | null; // 대표 학력 — 입학 시기 ("2024. 03")
  // 클럽 소속
  crewCode: string | null;
  statusLabel: string; // 상태(활동 중/엘리트/시즌 휴식/주차 휴식/활동 중단/온보딩/바사노스/-)
  activityStartDate: string; // 월요일 "26. 06. 15" | "-"
  activityStartWeek: string; // "25년, 여름, 2주차" | "-"
  activityEndDate: string; // 일요일 "26. 06. 21" | "~ing" | "-"
  activityEndWeek: string; // "26년, 봄, 13주차" | "~ing" | "-"
  classLabel: string; // 클래스
  teamName: string | null; // 소속 팀
  partName: string | null; // 파트
  // 클럽 결과(종합) — 표 A / 고객 cluster.1 / 이력서 카드 skill-num 과 동일 SoT 값.
  clubSummary: CrewClubSummary;
  // 클럽 결과(시즌) 상단부 — 고객 시즌 그로스 Details 동일 SoT 값.
  seasonSummary: CrewSeasonSummary;
  // 클럽 결과(시즌) 하단부 — 시즌별 결과 표(최신순·진행 중 맨 위). 고객 시즌 그로스 동일 SoT.
  seasonResults: CrewSeasonResultRow[];
  // 클럽 결과(주차) 상단부 — 고객 위클리 그로스 Details 동일 SoT 값.
  weekSummary: CrewWeekSummary;
  // 클럽 결과(주차) 하단부 — 주차 결과 표(오래된→최신). 고객 weekly-card 동일 SoT.
  weeklyResults: CrewWeeklyResultRow[];
};

// 클럽 결과(종합) 한 묶음. 모두 백엔드 SoT 직결값(프론트 재계산 금지).
//   숫자 0 은 실값(미참여=0)이며 null 만 "-" 로 표기한다.
export type CrewClubSummary = {
  successWeeks: number | null; // 성장 성공 주차 = 표 A successWeeks(period.a)
  poA: number; // 포인트 A = SUM(points) — 표 A Po.A
  poB: number; // 포인트 B = SUM(advantages) — 표 A Po.B
  poC: number; // 포인트 C = SUM(penalty) — 표 A Po.C
  scheduleReliability: number | null; // 일정 신뢰도(%) — 고객 cluster.1 동일 산식
  activityCompletion: number | null; // 활동 완료율(%) — 고객 cluster.1 동일 산식
  infoCount: number; // 실무 정보 = 이력서 카드 skill-num(practicalStats.infoCount)
  experienceCount: number; // 실무 경험 = practicalStats.experienceCount
  abilityUnitCount: number; // 실무 역량 = practicalStats.abilityUnitCount
  careerProjectCount: number; // 실무 경력 = practicalStats.careerProjectCount
};

// 클럽 결과(시즌) 상단부 — 고객 시즌 그로스 Details 동일 SoT(프론트 재계산 금지).
//   시즌 카운트 = user_season_statuses(rest=휴식, 그 외=성공, 가능=합) — /api/profile growthPeriodStats 동일.
//   시작/종료 시즌 = 고객 growthInfo.startWeekInfo/endWeekInfo 와 동일 산정(시즌 단위 표기).
//   현재 시즌만 어드민 표시 규칙(진행 중/휴식 중/-).
export type CrewSeasonSummary = {
  startSeason: string; // "2025년, 여름 시즌" | "-"
  endSeason: string; // "2025년, 여름 시즌" | "~ing (성장 진행 중)"
  currentSeason: string; // "2026년, 여름 시즌 - 진행 중" | "... - 휴식 중" | "-"
  availableSeasons: number; // 성장 가능 시즌 = 휴식+성공(f+g) — 현재 시즌 제외(uss 미생성)
  successSeasons: number; // 성장 성공 시즌 = g(rest 아닌 시즌)
  restSeasons: number; // 성장 휴식 시즌 = f(rest 시즌)
};

// 클럽 결과(주차) 상단부 — 고객 위클리 그로스(cluster-4-1) Details 동일 SoT(프론트 재계산 금지).
//   주차 카운트 = foldGrowthMetrics(snapshot 카드) = 고객 statsCards.period(cluster3 period a/b/c/e).
//     성공=a·실패=b·휴식=c·가능=e(=a+b+c, 현재 진행 중 주차는 running 이라 자연 제외).
//   시작/종료 주차 = 고객 growthInfo.startWeekInfo/endWeekInfo(시즌상대 week_number 포함).
//   현재 주차만 어드민 표시 규칙(성장 진행 중/개인 휴식 중/공식 휴식 중/-).
export type CrewWeekSummary = {
  startWeek: string; // "2025년, 여름 시즌, 6주차" | "-"
  endWeek: string; // "2025년, 여름 시즌, 8주차" | "~ing (성장 진행 중)"
  currentWeek: string; // "2026년, 여름 시즌, 8주차 - 성장 진행 중" | "... - 개인/공식 휴식 중" | "-"
  availableWeeks: number; // 성장 가능 주차 = e(a+b+c)
  successWeeks: number; // 성장 성공 주차 = a
  failWeeks: number; // 성장 실패 주차 = b
  restWeeks: number; // 성장 휴식 주차 = c
};

// timestamptz/date → "YYYY-MM-DD"(KST 기준, 앞 10자리). 파싱 불가 시 null.
function toDateOnly(value: string | null): string | null {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// "YYYY-MM-DD" → "YY. MM. DD"(6자리 표기). 파싱 불가 시 null.
function formatSixDigitDate(dateOnly: string | null | undefined): string | null {
  if (!dateOnly) return null;
  const m = String(dateOnly).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[1].slice(2)}. ${m[2]}. ${m[3]}`;
}

// season_key("2026-summer") + week_number → "26년, 여름, 2주차". 파싱 불가 시 null.
function formatWeekLabel(
  seasonKey: string | null,
  weekNumber: number | null,
): string | null {
  if (!seasonKey || weekNumber == null) return null;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  if (!m) return null;
  const yy = String(Number(m[1]) % 100).padStart(2, "0");
  const ko = SEASON_TYPE_KO[m[2]];
  if (!ko) return null;
  return `${yy}년, ${ko}, ${weekNumber}주차`;
}

// season_key("2025-summer") → "2025년, 여름 시즌"(시즌 단위·연도 4자리). 파싱 불가 null.
function formatSeasonLabelFromKey(seasonKey: string | null): string | null {
  if (!seasonKey) return null;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  if (!m) return null;
  const ko = SEASON_TYPE_KO[m[2]];
  if (!ko) return null;
  return `${m[1]}년, ${ko} 시즌`;
}

// seasons.name("2026년도 봄시즌" | "2026년도 봄 시즌") → "2026년, 봄 시즌". 파싱 불가 null.
//   졸업 종료 시즌은 user_season_histories.season_id→seasons(name) 에서 온다(아래 주석 참조).
function formatSeasonLabelFromName(name: string | null): string | null {
  if (!name) return null;
  const m = name.match(/(\d{4})년도\s*(겨울|봄|여름|가을)\s*시즌/);
  if (!m) return null;
  return `${m[1]}년, ${m[2]} 시즌`;
}

// date(YYYY-MM-DD) 를 포함하는 주차(start_date ≤ date ≤ end_date). 미일치 null.
function matchWeekByDate(weeks: WeekRow[], dateOnly: string): WeekRow | null {
  for (const w of weeks) {
    if (!w.start_date || !w.end_date) continue;
    if (dateOnly >= w.start_date && dateOnly <= w.end_date) return w;
  }
  return null;
}

// 대표 학력 선택 — is_primary 우선, sort_order 오름차순, updated_at 최신(고객앱 동일 규칙).
function pickPrimaryEducation(rows: EducationRow[]): EducationRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const primaryDelta = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
    if (primaryDelta !== 0) return primaryDelta;
    const sortDelta =
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
    if (sortDelta !== 0) return sortDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// 입학 시기 — admission_year(+ admission_month) → "2024. 03" | "2024". 연도 없으면 null.
function formatAdmissionPeriod(
  year: string | number | null,
  month: string | null,
): string | null {
  const y = year == null ? "" : String(year).trim().match(/(\d{4})/)?.[1] ?? "";
  if (!y) return null;
  const m = (month ?? "").trim();
  if (!m || m === "-") return y;
  const mm = /^\d$/.test(m) ? `0${m}` : m;
  return `${y}. ${mm}`;
}

// 졸업 종료 시즌 — user_season_histories 최신 행(created_at desc)의 시즌(seasons.name).
//   고객 /api/profile graduated 분기는 user_season_histories 최신 시즌과 동일 SoT 이지만,
//   고객 코드는 season_definitions!inner 조인을 쓰는데 user_season_histories→season_definitions
//   관계가 스키마에 없어(season_id→seasons 만 존재) 그 쿼리는 항상 에러→null→"~ing" 로 깨진다.
//   여기서는 실제 SoT(season_id→seasons.name)로 올바르게 해소한다 — 졸업 크루의 의미상 "마지막
//   시즌" 표기가 맞다. (현재 운영 졸업 크루 0명·테스트 9명뿐이라 노출 영향 없음. 고객 조인이
//   수정되면 양쪽이 동일 값으로 수렴.) 행/조인 없으면 null → 호출부가 "~ing" 폴백.
async function fetchGraduatedSeasonLabel(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("user_season_histories")
    .select("created_at,seasons!inner(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  // PostgREST 조인은 seasons 를 배열/객체 어느 쪽으로도 줄 수 있어 양쪽 모두 흡수.
  const raw = (data as { seasons?: unknown }).seasons;
  const s = (Array.isArray(raw) ? raw[0] : raw) as { name: string | null } | undefined;
  return formatSeasonLabelFromName(s?.name ?? null);
}

// 클럽 결과(시즌) 상단부 — 고객 시즌 그로스 Details 동일 SoT.
//   카운트(가능/성공/휴식) = user_season_statuses(rest=f, 그 외=g) — /api/profile growthPeriodStats 동일.
//   시작 시즌 = activity_started_at 포함 주차(없으면 joined/onboarding week)의 시즌.
//   종료 시즌 = (raw) 활동중단=suspended_week_id 주차 시즌 · 졸업=ush 최신 시즌 · 그 외 ~ing.
//   현재 시즌 = 어드민 표시 규칙(엘리트/활동중단=- · 현재 시즌 휴식=휴식 중 · 그 외=진행 중).
async function buildCrewSeasonSummary(args: {
  userId: string;
  profile: ProfileExtraRow;
  weeks: WeekRow[];
  seasonRows: SeasonStatusRow[];
  displayGrowthStatus: string | null;
  todayIso: string;
}): Promise<CrewSeasonSummary> {
  const { userId, profile, weeks, seasonRows, displayGrowthStatus, todayIso } = args;

  // 시즌 카운트 — 고객 growthPeriodStats 와 동일(rest→휴식, 그 외→성공, 가능=합).
  let restSeasons = 0;
  let successSeasons = 0;
  for (const r of seasonRows) {
    if (r.status === "rest") restSeasons++;
    else successSeasons++;
  }
  const availableSeasons = restSeasons + successSeasons;

  // 성장 시작 시즌 — activity_started_at 포함 주차의 시즌(고객 resolveGrowthStartWeek 1차 경로 동일).
  //   joined_week_id/onboarding_week_id 폴백은 이 DB user_profiles 에 컬럼이 없어(미populate) 미적용 —
  //   고객 경로도 실질적으로 activity_started_at 만 사용한다.
  const startDateOnly = toDateOnly(profile.activity_started_at);
  const startWeek = startDateOnly ? matchWeekByDate(weeks, startDateOnly) : null;
  const startSeason = formatSeasonLabelFromKey(startWeek?.season_key ?? null) ?? "-";

  // 성장 종료 시즌 — 고객 /api/profile 와 동일하게 raw growth_status/status 분기.
  const isGraduated = profile.status === "graduated" || profile.growth_status === "graduated";
  const isSuspended = profile.growth_status === "suspended";
  const IN_PROGRESS = "~ing (성장 진행 중)";
  let endSeason = IN_PROGRESS;
  if (isSuspended && profile.suspended_week_id) {
    const w = weeks.find((x) => x.id === profile.suspended_week_id) ?? null;
    endSeason = formatSeasonLabelFromKey(w?.season_key ?? null) ?? IN_PROGRESS;
  } else if (isGraduated) {
    endSeason = (await fetchGraduatedSeasonLabel(userId)) ?? IN_PROGRESS;
  }

  // 현재 시즌 — 어드민 표시 규칙. 엘리트/활동 중단(버킷)=- , 그 외=오늘 포함 주차의 시즌 + 진행/휴식.
  //   현재 시즌 SoT=weeks(오늘 포함 주차) — 고객 currentWeekRow 와 동일 source. 휴식=해당 시즌
  //   user_season_statuses.status='rest'(고객 currentSeasonStatus 동일). is_official_rest(주차 단위)와 무관.
  const bucket = statusBucket(displayGrowthStatus);
  let currentSeason = "-";
  if (bucket !== "elite" && bucket !== "suspended") {
    const currentWeek = matchWeekByDate(weeks, todayIso);
    const currentSeasonKey = currentWeek?.season_key ?? null;
    const label = formatSeasonLabelFromKey(currentSeasonKey);
    if (label) {
      const isRest = seasonRows.some(
        (r) => r.status === "rest" && r.season_key === currentSeasonKey,
      );
      currentSeason = `${label} - ${isRest ? "휴식 중" : "진행 중"}`;
    }
  }

  return { startSeason, endSeason, currentSeason, availableSeasons, successSeasons, restSeasons };
}

// season_key + 시즌상대 week_number → "2025년, 여름 시즌, 6주차". 파싱 불가 null.
function formatWeekFull(seasonKey: string | null, weekNumber: number | null): string | null {
  if (!seasonKey || weekNumber == null) return null;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  if (!m) return null;
  const ko = SEASON_TYPE_KO[m[2]];
  if (!ko) return null;
  return `${m[1]}년, ${ko} 시즌, ${weekNumber}주차`;
}

// 현재 주차 카드 상태 → 표시 라벨(어드민 규칙).
function weekStatusLabel(userWeekStatus: string | null): string {
  if (userWeekStatus === "personal_rest") return "개인 휴식 중";
  if (userWeekStatus === "official_rest") return "공식 휴식 중";
  return "성장 진행 중"; // running/tallying/success/fail
}

// 클럽 결과(주차) 상단부 — 고객 위클리 그로스 Details 동일 SoT.
//   카운트(가능/성공/실패/휴식) = foldGrowthMetrics(snapshot 카드) — deriveRosterCardStats/cluster3 period 동일 fold.
//   시작 주차 = activity_started_at 포함 주차(시즌상대 week_number 포함).
//   종료 주차 = (raw) 활동중단=suspended_week_id 주차 · 졸업=ush 최신 시즌(주차 없음) · 그 외 ~ing.
//   현재 주차 = 어드민 표시 규칙(엘리트/활동중단=- · 오늘 포함 주차 + 카드 상태별 진행/개인휴식/공식휴식).
async function buildCrewWeekSummary(args: {
  userId: string;
  profile: ProfileExtraRow;
  weeks: WeekRow[];
  displayGrowthStatus: string | null;
  todayIso: string;
  cards: Cluster4WeeklyCardDto[];
}): Promise<CrewWeekSummary> {
  const { userId, profile, weeks, displayGrowthStatus, todayIso, cards } = args;

  // 주차 카운트 — deriveRosterCardStats 와 동일 fold(전환 주차 제외·restSeasonCount 무관).
  //   running/tallying(현재 진행 중·미확정)은 success/fail/personal_rest 가 아니므로 자연 제외 → 가능(e)=현재 직전까지.
  const { approvedWeeks, failedWeeks, restWeeks, availableWeeks } = foldGrowthMetrics({
    weeks: cards.map((c) => ({
      status: c.userWeekStatus,
      isTransition: isTransitionWeekStart(c.startDate),
    })),
    restSeasonCount: 0,
  });

  // 성장 시작 주차 — activity_started_at 포함 주차(고객 startWeekInfo 동일·시즌상대 주차).
  const startDateOnly = toDateOnly(profile.activity_started_at);
  const startWeekRow = startDateOnly ? matchWeekByDate(weeks, startDateOnly) : null;
  const startWeek = formatWeekFull(startWeekRow?.season_key ?? null, startWeekRow?.week_number ?? null) ?? "-";

  // 성장 종료 주차 — raw 분기(활동중단=주차 포함·졸업=시즌만·그 외 ~ing).
  const isGraduated = profile.status === "graduated" || profile.growth_status === "graduated";
  const isSuspended = profile.growth_status === "suspended";
  const IN_PROGRESS = "~ing (성장 진행 중)";
  let endWeek = IN_PROGRESS;
  if (isSuspended && profile.suspended_week_id) {
    const w = weeks.find((x) => x.id === profile.suspended_week_id) ?? null;
    endWeek = formatWeekFull(w?.season_key ?? null, w?.week_number ?? null) ?? IN_PROGRESS;
  } else if (isGraduated) {
    // 졸업 종료 주차 = ush 최신 시즌(고객 endWeekInfo.weekNumber=null → 주차 미표기). 시즌 라벨 그대로.
    endWeek = (await fetchGraduatedSeasonLabel(userId)) ?? IN_PROGRESS;
  }

  // 현재 주차 — 어드민 표시 규칙. 엘리트/활동 중단(버킷)=- , 그 외 오늘 포함 주차 + 카드 상태.
  const bucket = statusBucket(displayGrowthStatus);
  let currentWeek = "-";
  if (bucket !== "elite" && bucket !== "suspended") {
    const currentWeekRow = matchWeekByDate(weeks, todayIso);
    const label = formatWeekFull(currentWeekRow?.season_key ?? null, currentWeekRow?.week_number ?? null);
    if (label) {
      // 오늘 포함 주차 카드의 userWeekStatus(개인/공식 휴식 구분). 카드 없으면 진행 중.
      const todayCard = cards.find((c) => c.startDate <= todayIso && todayIso <= c.endDate) ?? null;
      currentWeek = `${label} - ${weekStatusLabel(todayCard?.userWeekStatus ?? null)}`;
    }
  }

  return {
    startWeek,
    endWeek,
    currentWeek,
    availableWeeks,
    successWeeks: approvedWeeks,
    failWeeks: failedWeeks,
    restWeeks,
  };
}

// 단건 크루 상세 DTO. 매칭 행 없으면 null(라우트가 404 처리).
//   generatedBy = 크루 코드 lazy 생성 로그의 작성자(관리자 userId).
export async function getCrewDetailDto(
  userId: string,
  options: { generatedBy?: string | null } = {},
): Promise<CrewDetailData | null> {
  const crew = await getAdminCrewDtoByLegacyUserId(userId);
  if (!crew) return null;

  const id = crew.userId;
  const todayIso = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10); // KST 달력일

  const [
    profileRes,
    eduRes,
    weeksRes,
    growthRows,
    crewCode,
    isTestUser,
    points,
    resume,
    seasonStatusRes,
    seasonResults,
    weekSnapshot,
    weeklyResults,
  ] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select(
        "address,activity_started_at,activity_ended_at,suspended_week_id,growth_status,status",
      )
      .eq("user_id", id)
      .maybeSingle(),
    supabaseAdmin
      .from("user_educations")
      .select("school_name,major_name_1,admission_year,admission_month,sort_order,is_primary,updated_at")
      .eq("user_id", id),
    supabaseAdmin
      .from("weeks")
      .select("id,start_date,end_date,season_key,week_number")
      .not("start_date", "is", null)
      .order("start_date", { ascending: true })
      .range(0, 9999),
    getGrowthRosterBatchFast([id]),
    lazyEnsureCrewCode(id, options.generatedBy ?? null),
    isMarkedTestUser(id),
    // 포인트 A/B/C — 표 A 와 동일 누적 합산 SoT.
    sumPointsForUsers([id]),
    // 일정 신뢰도·활동 완료율·실무 4종 skill-num — 고객 cluster.1/이력서 카드 단일 SoT.
    //   getCluster1Resume 은 legacyUserId(라우트 param) 기준으로 다시 crew 를 해소하므로 userId 를 넘긴다.
    getCluster1Resume(userId),
    // 시즌 카운트(가능/성공/휴식) SoT — 고객 /api/profile growthPeriodStats 와 동일 read.
    supabaseAdmin
      .from("user_season_statuses")
      .select("status,season_key")
      .eq("user_id", id),
    // 시즌별 결과 표 — 고객 시즌 그로스 동일 SoT(결과/포인트/허브강화율/소속·클래스).
    getCrewSeasonResults(id, todayIso),
    // 주차 카운트/현재 주차 상태 SoT — weekly-cards snapshot(읽기 전용). 고객 위클리 그로스 Details 동일.
    readWeeklyCardsSnapshot(id),
    // 주차 결과 표 — 고객 weekly-card 동일 SoT(주차별 결과/누적성공/소속/포인트/허브강화율).
    getCrewWeeklyResults(id),
  ]);

  if (profileRes.error) throw new Error(`user_profiles load failed: ${profileRes.error.message}`);
  if (eduRes.error) throw new Error(`user_educations load failed: ${eduRes.error.message}`);
  if (weeksRes.error) throw new Error(`weeks load failed: ${weeksRes.error.message}`);
  if (seasonStatusRes.error)
    throw new Error(`user_season_statuses load failed: ${seasonStatusRes.error.message}`);

  const profile = (profileRes.data ?? null) as ProfileExtraRow | null;
  const weeks = (weeksRes.data ?? []) as unknown as WeekRow[];

  // 대표 학력 — 학교/전공/입학 시기는 동일 행에서.
  const primaryEdu = pickPrimaryEducation((eduRes.data ?? []) as unknown as EducationRow[]);
  const schoolName = primaryEdu?.school_name ?? crew.schoolName ?? null;
  const departmentName = primaryEdu?.major_name_1 ?? crew.departmentName ?? null;
  const admissionPeriod = primaryEdu
    ? formatAdmissionPeriod(primaryEdu.admission_year, primaryEdu.admission_month)
    : null;

  // 상태 — 표시 성장상태 → 버킷(라벨/종료 노출 판정 공용).
  const growth = growthRows[0] ?? null;
  const displayStatus = growth?.displayGrowthStatus ?? null;
  const bucket = statusBucket(displayStatus);
  const statusLabel = statusBucketLabel(displayStatus);

  // 클럽 결과(종합) — 표 A / 고객 cluster.1 / 이력서 카드 skill-num 동일 SoT 직결값.
  const pts = points.get(id) ?? null;
  const clubSummary: CrewClubSummary = {
    successWeeks: growth?.successWeeks ?? null,
    poA: pts?.checkPoints ?? 0,
    poB: pts?.advantagePoints ?? 0,
    poC: pts?.penaltyPoints ?? 0,
    scheduleReliability: resume?.scheduleReliability.rate ?? null,
    activityCompletion: resume?.activityCompletion.rate ?? null,
    infoCount: resume?.practicalStats.infoCount ?? 0,
    experienceCount: resume?.practicalStats.experienceCount ?? 0,
    abilityUnitCount: resume?.practicalStats.abilityUnitCount ?? 0,
    careerProjectCount: resume?.practicalStats.careerProjectCount ?? 0,
  };

  // 클럽 결과(시즌) 상단부 — 고객 시즌 그로스 Details 동일 SoT. (todayIso 는 위에서 1회 산정)
  const seasonRows = (seasonStatusRes.data ?? []) as unknown as SeasonStatusRow[];
  const seasonSummary: CrewSeasonSummary = profile
    ? await buildCrewSeasonSummary({
        userId: id,
        profile,
        weeks,
        seasonRows,
        displayGrowthStatus: displayStatus,
        todayIso,
      })
    : {
        startSeason: "-",
        endSeason: "~ing (성장 진행 중)",
        currentSeason: "-",
        availableSeasons: 0,
        successSeasons: 0,
        restSeasons: 0,
      };

  // 클럽 결과(주차) 상단부 — 고객 위클리 그로스 Details 동일 SoT(snapshot 카드 기반).
  const weekCards =
    weekSnapshot.status === "hit" || weekSnapshot.status === "stale" ? weekSnapshot.cards : [];
  const weekSummary: CrewWeekSummary = profile
    ? await buildCrewWeekSummary({
        userId: id,
        profile,
        weeks,
        displayGrowthStatus: displayStatus,
        todayIso,
        cards: weekCards,
      })
    : {
        startWeek: "-",
        endWeek: "~ing (성장 진행 중)",
        currentWeek: "-",
        availableWeeks: 0,
        successWeeks: 0,
        failWeeks: 0,
        restWeeks: 0,
      };

  // 활동 시작 — 시작일 포함 주차의 월요일(start_date) + 주차 라벨.
  const startDateOnly = toDateOnly(profile?.activity_started_at ?? null);
  const startWeek = startDateOnly ? matchWeekByDate(weeks, startDateOnly) : null;
  const activityStartDate =
    formatSixDigitDate(startWeek?.start_date ?? startDateOnly) ?? "-";
  const activityStartWeek = startWeek
    ? formatWeekLabel(startWeek.season_key, startWeek.week_number) ?? "-"
    : "-";

  // 활동 종료 — 종료일(activity_ended_at) 포함 주차의 일요일, 없으면 suspended_week_id 주차.
  //   엘리트/활동 중단일 때만 노출. 그 외 진행 상태=~ing, 미상(-)=-.
  const endDateOnly = toDateOnly(profile?.activity_ended_at ?? null);
  let endWeek = endDateOnly ? matchWeekByDate(weeks, endDateOnly) : null;
  if (!endWeek && profile?.suspended_week_id) {
    endWeek = weeks.find((w) => w.id === profile.suspended_week_id) ?? null;
  }
  const hasEnd = bucket === "elite" || bucket === "suspended";
  let activityEndDate: string;
  let activityEndWeek: string;
  if (hasEnd) {
    // 엘리트/활동 중단 — 실제 종료일(일요일)/종료 주차. 미상이면 "-".
    activityEndDate = formatSixDigitDate(endWeek?.end_date) ?? "-";
    activityEndWeek = endWeek
      ? formatWeekLabel(endWeek.season_key, endWeek.week_number) ?? "-"
      : "-";
  } else {
    // 그 외 상태(진행/미상 포함) — 종료일 "~ing", 종료 주차 "-".
    activityEndDate = "~ing";
    activityEndWeek = "-";
  }

  return {
    userId: id,
    displayName: crew.displayName,
    organizationSlug: crew.organizationSlug,
    isTestUser,
    profilePhotoUrl: crew.profilePhotoUrl,
    gender: crew.gender,
    birthDate: crew.birthDate,
    age: crew.age,
    address: profile?.address ?? null,
    contactPhone: crew.contactPhone,
    contactEmail: crew.contactEmail,
    schoolName,
    departmentName,
    admissionPeriod,
    crewCode,
    statusLabel,
    activityStartDate,
    activityStartWeek,
    activityEndDate,
    activityEndWeek,
    classLabel: classLabel(crew.role, crew.membershipLevel),
    teamName: crew.teamName,
    partName: crew.partName,
    clubSummary,
    seasonSummary,
    seasonResults,
    weekSummary,
    weeklyResults,
  };
}
