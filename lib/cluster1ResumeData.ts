import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getCurrentActivityDateIso,
  isTransitionWeekStart,
  getSeasonForDate,
  seasonTypeToCode,
  seasonDbKey,
} from "@/lib/seasonCalendar";
import { computeScheduleReliabilityFromRows } from "@/lib/scheduleReliabilityCore";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { EXPERIENCE_RATING_FAIL_THRESHOLD } from "@/lib/cluster4Enhancement";
import { isCareerGradeFail, type CareerGrade } from "@/lib/careerGrade";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import { getGrowthIndicators } from "@/lib/cluster3GrowthData";
import {
  RESUME_BADGE_BY_GROWTH_STATUS,
  isManualOverrideStatus,
  type GrowthStatusKey,
} from "@/shared/growth.contracts";
import {
  resolveSeasonPosition,
  POSITION_CODE_TO_LABEL,
  type PositionCode,
} from "@/lib/positionHistory";
// 주차별 파트/클래스 관리자 override — effective = override ?? UPH(관리자 팀 상세 [B] 와 동일 SoT).
import {
  loadUserPositionOverrideRows,
  resolveOverrideAt,
} from "@/lib/teamWeekPositionOverride";
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

  const rows = weekRes.data as Array<{
    week_start_date: string | null;
    status: string;
  }>;

  // 단일 산식은 lib/scheduleReliabilityCore 로 통일(배치/slim writer 와 drift 차단).
  //   산정 불가(activity_started_at 부재/무효) → resume 화면은 dummy 폴백(rate 94) 유지.
  const result = computeScheduleReliabilityFromRows(activityStart, rows, Date.now());
  return result ?? dummyScheduleReliability();
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
// 일정 신뢰도 배치 (/admin/members 크루 목록) — computeScheduleReliability 와 동일 산식.
//   사용자별 2쿼리(uws + profile) 대신, 대상 전원의 user_week_statuses·activity_started_at 을
//   각각 1배치로 모아 메모리에서 동일 로직으로 계산한다(N+1 회피).
//   activity_started_at 이 없는 사용자는 산정 불가 → null(어드민 표는 "—" 표시).
//   (고객 resume 의 dummy(rate 94) 폴백은 데이터 부재용 placeholder 라 어드민 합산에는 쓰지 않는다.)
// ─────────────────────────────────────────────────────────────────────
export async function getScheduleReliabilityRateBatch(
  userIds: string[],
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (userIds.length === 0) return map;

  const ID_CHUNK = 200;

  // 1) activity_started_at 배치
  const startById = new Map<string, string | null>();
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,activity_started_at")
      .in("user_id", chunk);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{
      user_id: string;
      activity_started_at: string | null;
    }>) {
      startById.set(row.user_id, row.activity_started_at);
    }
  }

  // 2) user_week_statuses 배치 (PostgREST 1000행 cap → 청크당 페이지네이션)
  const rowsByUser = new Map<string, Array<{ week_start_date: string | null; status: string }>>();
  const ROW_PAGE = 1000;
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("user_week_statuses")
        .select("user_id,week_start_date,status")
        .in("user_id", chunk)
        .order("user_id", { ascending: true })
        .range(from, from + ROW_PAGE - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{
        user_id: string;
        week_start_date: string | null;
        status: string;
      }>;
      for (const r of rows) {
        const list = rowsByUser.get(r.user_id) ?? [];
        list.push({ week_start_date: r.week_start_date, status: r.status });
        rowsByUser.set(r.user_id, list);
      }
      if (rows.length < ROW_PAGE) break;
      from += ROW_PAGE;
    }
  }

  // 3) 사용자별 rate — computeScheduleReliability 와 동일 코어(lib/scheduleReliabilityCore).
  //    산정 불가(activity_started_at 부재/무효) → null(어드민 표 "—"). resume dummy 는 미사용.
  const nowMs = Date.now();
  for (const userId of userIds) {
    const result = computeScheduleReliabilityFromRows(
      startById.get(userId) ?? null,
      rowsByUser.get(userId) ?? [],
      nowMs,
    );
    map.set(userId, result ? result.rate : null);
  }

  return map;
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
//
//   (2026-06-05 경량화) 카드 source 를 라이브 계산(getCluster4WeeklyCardsForProfileUser,
//   40주 사용자 기준 8~10s)에서 weekly-cards snapshot 직독(readWeeklyCardsSnapshot, 단일
//   SELECT)으로 교체. 고객 front 의 resume 그래프트가 타임아웃으로 레거시 폴백에 빠지던
//   원인 제거. stale(구버전 포함)도 카드 배열을 그대로 합산(허브 HTTP 와 동일한 graceful
//   노출 정책). miss/error 만 0/0/0 — 이 경로에서 라이브 재계산은 절대 하지 않는다.
// ─────────────────────────────────────────────────────────────────────
async function computeActivityCompletion(
  userId: string,
): Promise<ActivityCompletion> {
  const snapshot = await readWeeklyCardsSnapshot(userId);
  if (snapshot.status === "miss" || snapshot.status === "error") {
    console.warn("[cluster1] activityCompletion snapshot unavailable → 0/0/0", {
      userId,
      status: snapshot.status,
      message: snapshot.status === "error" ? snapshot.message : undefined,
    });
    return { availableActivities: 0, completedActivities: 0, rate: 0 };
  }
  if (snapshot.status === "stale") {
    console.warn("[cluster1] activityCompletion snapshot stale → 구값 합산", {
      userId,
      reason: snapshot.reason,
      computedAt: snapshot.computedAt,
    });
  }
  const cards: Cluster4WeeklyCardDto[] = snapshot.cards;

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
  "정규": 1,
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

// "YYYY-MM-DD" + n일 → "YYYY-MM-DD". UTC 자정 기준 달력일 가산(시/분/타임존 무관).
function addCalendarDays(dateStr: string, days: number): string {
  const ms = Date.UTC(
    +dateStr.slice(0, 4),
    +dateStr.slice(5, 7) - 1,
    +dateStr.slice(8, 10),
  );
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

// 학기 시즌(16주) 판별 — 방학(여름/겨울 8주)과 검수 확정 경계가 다르다.
const SEMESTER_SEASON_TYPES = new Set(["spring", "autumn"]);

// 시즌 이력이 "승인 완료"로 최종 확정되는 월요일(포함, KST date-only). 시작일 기준 달력일 가산.
//   · 학기(봄/가을): 같은 시즌 15주차 월요일 = 시작일 + 98일(14주 뒤).
//       14주차 목요일 공표 → 금요일 14시 활동 종료 → 15주차 월요일 최종 확정.
//   · 방학(여름/겨울): 다음 시즌 2주차 월요일 = 시작일 + 70일.
//       방학 8주 + 전환 1주 = 9주(63일) 뒤 다음 시즌 1주차, 그 다음 주(2주차) 월요일 확정.
//       다음 시즌 1주차 목요일 공표 → 금요일 14시 종료 → 2주차 월요일 최종 확정.
//   종전 규칙(end_date + 14일)은 "2주 경과" 근사라 학기 결산(15주차 월요일)보다 늦게 승인
//   완료로 넘어가 이미 결산된 시즌이 계속 "검수 중"으로 남던 결함이 있었다(2026-07-03 교체).
function seasonReviewApprovalMonday(
  seasonType: string,
  startDateIso: string,
): string {
  const offsetDays = SEMESTER_SEASON_TYPES.has(seasonType) ? 98 : 70;
  return addCalendarDays(startDateIso.slice(0, 10), offsetDays);
}

function resolveSeasonReviewStatus(
  seasonType: string,
  startDateIso: string,
  todayKst: string,
): SeasonRecord["reviewStatus"] {
  return todayKst >= seasonReviewApprovalMonday(seasonType, startDateIso)
    ? "승인 완료"
    : "검수 중";
}

// export — 시즌별 결과 표(/admin/members 상세)가 시즌 결과 라벨 SoT 로 재사용한다.
//   고객 시즌 그로스의 deriveSeasonStatus 가 이 progressStatus 를 graft 하는 단일 출처이므로,
//   admin 표도 동일 함수를 직접 써서 화면 간 결과 라벨을 일치시킨다.
export async function computeSeasonRecords(
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

  // 시즌 직책 SoT(2026-06-22 개편) = user_position_histories(주차단위 PMS 이관 이력).
  //   시즌별로 그 시즌 주차들의 직책을 모아 resolveSeasonPosition(3주룰)으로 대표 직책 산정.
  //   과거 시즌에 현재 직책을 복사하던 종전 버그 제거.
  //   PMS 이력이 없는 시즌(현재 2026 시즌·native 미이관자)만 현재 membership/role 로 fallback.
  const [membershipRes, profileRoleRes, positionRes, positionOverrideRows] = await Promise.all([
    supabaseAdmin
      .from("user_memberships")
      .select("membership_level,is_current,created_at,updated_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("user_profiles")
      .select("role,growth_status")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_position_histories")
      .select("season_key,position_code,week_start_date,raw_team")
      .eq("user_id", userId),
    loadUserPositionOverrideRows(userId),
  ]);

  // 시즌별 대표 직책 맵. 테이블 미적용/조회실패 시 빈 맵 → 전 시즌 현재 membership fallback
  //   (= 종전 동작, 무회귀). PMS 이력 보유 시즌만 주차단위 산정값으로 덮인다.
  const seasonPositionMap = new Map<string, PositionCode>();
  if (positionRes.error) {
    console.warn("[cluster1] user_position_histories 조회 실패 → 전 시즌 현재 직책 fallback", {
      userId,
      message: positionRes.error.message,
    });
  } else {
    // effective = carry-forward override ?? UPH — 저장 주차부터 이후 주차 전부에 이어진다.
    //   시즌 대표(resolveSeasonPosition, 3주룰)는 그 시즌 주차들의 effective 코드로 산정한다.
    const overrideAsc = [...positionOverrideRows].sort((a, b) =>
      a.weekStartDate.localeCompare(b.weekStartDate),
    );
    const seasonKeyByWeekStart = new Map<string, string>();
    for (const w of weeks)
      if (w.week_start_date && w.season_key)
        seasonKeyByWeekStart.set(String(w.week_start_date).slice(0, 10), w.season_key);

    const seenWeeks = new Set<string>();
    const codesBySeason = new Map<string, PositionCode[]>();
    const push = (seasonKey: string | null, code: PositionCode) => {
      if (!seasonKey) return;
      const arr = codesBySeason.get(seasonKey) ?? [];
      arr.push(code);
      codesBySeason.set(seasonKey, arr);
    };
    for (const r of (positionRes.data ?? []) as Array<{
      season_key: string | null;
      position_code: PositionCode;
      week_start_date: string | null;
      raw_team: string | null;
    }>) {
      if (r.week_start_date) seenWeeks.add(r.week_start_date);
      const ovr = r.week_start_date ? resolveOverrideAt(overrideAsc, r.week_start_date) : null;
      push(r.season_key, ovr ? ovr.positionCode : r.position_code);
    }
    // UPH 행이 없는 주차에 저장된 override 는 그 주차 몫으로 1건 추가(이월분은 위에서 반영됨).
    for (const o of overrideAsc) {
      if (seenWeeks.has(o.weekStartDate)) continue;
      push(seasonKeyByWeekStart.get(o.weekStartDate) ?? null, o.positionCode);
    }
    for (const [key, codes] of codesBySeason) {
      const resolved = resolveSeasonPosition(codes);
      if (resolved) seasonPositionMap.set(key, resolved);
    }
  }
  const profileRow = profileRoleRes.data as {
    role: string | null;
    growth_status: string | null;
  } | null;
  const profileRole = profileRow?.role ?? null;
  // "정상 졸업" = 실제 졸업(growth_status SoT)일 때만. 종전에는 시즌 완주(approved≥total−1)를
  // 졸업으로 라벨링해, 미졸업자의 과거 완료 시즌에도 "정상 졸업"이 붙었다 (2026-06-05 수정).
  const isGraduated = profileRow?.growth_status === "graduated";
  // 마지막 활동 시즌 = uws 가 존재하는 시즌 중 최신(seasons 는 start_date DESC 정렬).
  const latestActivitySeasonKey =
    seasons.find((s) => weeksBySeason.has(s.season_key))?.season_key ?? null;

  const records: SeasonRecord[] = [];
  // 위 루프에서 실제 행이 생성된 시즌 키 — 아래 "새 시즌 즉시 노출" 중복 방지에 사용.
  const presentSeasonKeys = new Set<string>();

  const now = new Date();
  // 시즌 검수 상태 경계는 KST date-only(UTC timestamp 비교 금지) — 단일 today 로 전 시즌 비교.
  const todayKst = getCurrentActivityDateIso(now.getTime());

  for (const season of seasons) {
    const seasonWeeks = weeksBySeason.get(season.season_key);
    if (!seasonWeeks || seasonWeeks.length === 0) continue;
    presentSeasonKeys.add(season.season_key);

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

    // progressStatus "진행 중" 판정은 기존 동작 보존(시즌 종료일 timestamp 기준).
    const isOngoing = now <= new Date(season.end_date);

    let progressStatus: SeasonRecord["progressStatus"];
    const hasRest = seasonWeeks.some((w) => w.status === "personal_rest");
    const hasFail = seasonWeeks.some((w) => w.status === "fail");

    // "정상 졸업"은 실졸업자(growth_status=graduated)의 마지막 활동 시즌 행에만 붙는다.
    // 진행 중 시즌이더라도 졸업이 확정된 사용자의 최신 행은 "정상 졸업"이 우선한다
    // (정상 졸업은 맨 윗 행 = 현재/최신 시즌에 표시 — 2026-06-05 정책).
    if (isGraduated && season.season_key === latestActivitySeasonKey) {
      progressStatus = "정상 졸업";
    } else if (isOngoing) {
      progressStatus = "진행 중";
    } else if (hasRest && !hasFail && approvedWeeks === 0) {
      // "통합 휴식" = 그 시즌이 전체적으로 휴식으로 볼 수 있는 경우로 한정한다
      // (2026-06-29 정정). 인정(공표 success) 주차가 0이고 실패도 없는데 휴식 주차만
      // 있는 시즌만 통합 휴식이다. 일부 주차만 휴식이고 활동 성공(인정) 주차가 1개라도
      // 있으면 — 분기 순서상 종전엔 success 9주여도 휴식 1주에 강등됐다 — 아래 "정상 완료"로
      // 떨어진다. 인정 주차 0 기준은 바로 아래 "활동 중단"(hasFail) 분기와 동일한 SoT다.
      progressStatus = "통합 휴식";
    } else if (hasFail && approvedWeeks === 0) {
      // 활동 중단 = 그 시즌에 인정(공표 success) 주차가 0인데 실패만 있는 경우로 한정한다
      // (2026-06-07 정정). 인정 주차가 1개 이상이면 — 절반 미만이라도 — 과거 시즌의 완료
      // 이력을 "활동 중단"으로 덮지 않는다. PMS 이관 사용자는 전 주차가 아니라 일부만
      // 인정받는 패턴이 정상이므로 종전의 totalWeeks/2 기준은 과잉 강등이었다.
      progressStatus = "활동 중단";
    } else {
      progressStatus = "정상 완료";
    }

    // 시즌 검수 상태 — 시즌 타입별 결산 경계(seasonReviewApprovalMonday) 기준.
    //   학기(봄/가을)=15주차 월요일, 방학(여름/겨울)=다음 시즌 2주차 월요일부터 "승인 완료".
    const reviewStatus = resolveSeasonReviewStatus(
      season.season_type,
      season.start_date,
      todayKst,
    );

    const yearStr = season.season_key.slice(2, 4);
    const seasonName =
      SEASON_LABEL_MAP[season.season_type] ?? season.season_label;

    // 시즌별 실제 이력 우선. 이력 없는 시즌(현재 2026·미이관자)만 현재 membership/role.
    const seasonPositionCode = seasonPositionMap.get(season.season_key);
    const position: PositionLabel = seasonPositionCode
      ? POSITION_CODE_TO_LABEL[seasonPositionCode]
      : resolvePosition(membershipRes.data ?? [], profileRole);

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

  // ── 새 시즌 즉시 노출 ──────────────────────────────────────────────
  // 오늘(KST) 기준 현재 시즌 1주차가 시작됐는데 아직 활동(uws) 행이 없어 위 루프에서
  //   빠진 경우, "진행 중" 시즌 행을 합성해 맨 위에 노출한다 — 새 시즌 시작 즉시 이력서
  //   카드에 해당 시즌 내역이 보이도록 한다(예: 26 여름 1주차 시작 → 26 여름 시즌 노출).
  //   getSeasonForDate 는 시즌 1주차 월요일(전환 주차 제외)부터 다음 시즌으로 넘어간다.
  //
  //   범위 한정(오노출 방지):
  //     · 실제 활동 이력이 있는 크루만(records.length>0) — 더미/0이력 사용자엔 미주입.
  //     · 운영 종료 상태(졸업/중단/유보 = MANUAL_OVERRIDE_STATUSES) 아님 — 이미 떠난
  //       사용자에게 새 시즌 "진행 중"을 붙이지 않는다.
  //     · 이미 그 시즌 행이 있으면(uws 존재) 중복 주입하지 않는다.
  const currentSeason = getSeasonForDate(todayKst);
  if (
    currentSeason &&
    records.length > 0 &&
    !isManualOverrideStatus(profileRow?.growth_status ?? null) &&
    !presentSeasonKeys.has(seasonDbKey(currentSeason))
  ) {
    const typeCode = seasonTypeToCode(currentSeason.type);
    records.unshift({
      year: String(currentSeason.year).slice(2),
      seasonName: SEASON_LABEL_MAP[typeCode] ?? `${currentSeason.type} 시즌`,
      // 현재 소속/직책(과거 이력 없는 신규 시즌이므로 현재 membership/role).
      position: resolvePosition(membershipRes.data ?? [], profileRole),
      progressStatus: "진행 중",
      approvedWeeks: 0,
      totalWeeks: SEASON_TOTAL_WEEKS[typeCode] ?? currentSeason.seasonWeeks,
      reviewStatus: resolveSeasonReviewStatus(
        typeCode,
        currentSeason.startDate,
        todayKst,
      ),
    });
  }

  return records.length > 0 ? records : dummySeasonRecords();
}

// 등급 SoT = membership_level("일반"/"심화"), role 은 보조 (2026-06-04 통일 —
// /admin/members memberStatusLabel · cluster4 buildActivityLabels 와 동일 정책).
//   - 운영진 role(team_leader/ambassador) → 등급 체계 밖, 운영진 라벨 (기존 정책 유지)
//   - 심화 + part_leader → "심화(파트장)" / 심화 + 그 외 role → "심화(에이전트)"
//   - 일반(또는 등급 미보유/미확정) → "정규" — role 단독으로 직책을 만들지 않는다.
// 종전 구현은 POSITION_RANK 의 풀라벨 키("심화(파트장)" 등)만 인정해 실제 DB 값
// "심화"가 전부 "정규"로 떨어지는 결함이 있었다(심화 멤버 전원 오표기).
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
  return "정규";
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
      position: "정규",
      progressStatus: "정상 완료",
      approvedWeeks: 11,
      totalWeeks: 12,
      reviewStatus: "승인 완료",
    },
    {
      year: "24",
      seasonName: "겨울 시즌",
      position: "정규",
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
//   공통 규칙:
//     ① 공표 필터: weeks.result_published_at 있는 주차만 (미공표/검수중 제외).
//     ② 강화 성공만: 마감(submission_closes_at) 지난 본인 user target 중 success 만.
//        - info/competency: 마감 = success (평가 체계 없음 — 허브와 동일 기준).
//        - experience: rating ≥ 4 만. rating ≤ 3(강화 실패)·미평가 제외
//          (허브는 미평가=success 로 치지만 이력서는 "평가 확정" 전엔 카운트하지 않는다).
//        - career: grade S/A/B/C 만. D(강화 실패)·미평가 제외.
//     ③ 집계 단위(2026-06-21 info 정정):
//        - info(실무 정보 습득): 성공한 **distinct 라인 수**. weekly-cards 의 "실무 정보 N개 중 M개"
//          (라인=활동 단위, 위즈덤/에세이/… 각각 1개) 의 성공 개수(M)와 1:1 일치시킨다. 같은 주차에
//          여러 info 라인을 성공하면 그만큼 +N (위즈덤·에세이·인포데스크 = 3건). 제출 여부 무관(배정+마감=성공).
//        - experience/competency/career: 종전대로 **주차 fold**(part 당 주차 1 unit) 유지(불변).
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
  //   info 는 distinct **라인**(활동 단위)으로 집계 — weekly-cards 의 라인별 success 개수와 일치.
  //   experience/competency/career 는 종전대로 distinct **주차**(주차 fold) 유지(불변).
  const infoLines = new Set<string>();
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
        // 실무 정보 습득 = 성공한 distinct 라인 수(같은 주차 여러 라인 = 그만큼 +N).
        infoLines.add(t.line_id);
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

  // ③ 집계: info = distinct 라인 수, 그 외 = distinct 성공 주차 수(주차 fold).
  return {
    infoCount: infoLines.size,
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
