import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  findExperienceMasterIdByLineNameRegFirst,
  getExperienceSlotsByMasterIdsRegFirst,
} from "@/lib/lineRegistrationLookup";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import {
  computeCluster4Enhancement,
  EXPERIENCE_RATING_FAIL_THRESHOLD,
  DEFAULT_WEEK_CHECK_THRESHOLD,
} from "@/lib/cluster4Enhancement";
import type {
  Cluster4EnhancementStatus,
  Cluster4ExperienceCategory,
} from "@/shared/cluster4.contracts";
import { type CareerGrade, isCareerGradeFail } from "@/lib/careerGrade";

// ─────────────────────────────────────────────────────────────────────
// 실무 경험 5슬롯 정책 (2026-06-04 확정):
//   - 1(도출)·2(분석)·3(평가)·5(관리) 슬롯은 라인 행 존재 여부와 무관하게 "항상 오픈/마감된
//     것"으로 본다 → 해당 없음(not_applicable) 불가. 본인 타깃 없으면(라인 행이 아예 없어도)
//     강화 실패(fail), 타깃 있으면 마감 전 pending / 마감 후 success(평점 rating<=3 만 fail).
//   - 4(확장) 슬롯만 정해진 주차에만 열린다 → 미개설 주차는 해당 없음(not_applicable).
// 슬롯 상태는 weekly-cards 라인 DTO(placeholder 포함)와 강화율 분모 A 양쪽에 동일하게 반영된다.
// ─────────────────────────────────────────────────────────────────────
export const EXPERIENCE_ALWAYS_OPEN_SLOT_ORDERS = [1, 2, 3, 5] as const;

// ─────────────────────────────────────────────────────────────────────
// 허브/라인 체계 적용 시점 (2026-06-05 개정 — 레거시 통합 라인 정책):
//   - 허브/라인 체계(4허브·5슬롯·필수 슬롯 항상-개설)는 2026 여름 시즌 1주차
//     (2026-06-29) 시작 주차부터 적용한다. 실사용자/테스트 사용자 구분 없음 —
//     종전의 "테스트 사용자 전 주차 적용" 예외는 폐기한다.
//   - 이 날짜 이전(= 2026 봄 시즌 16주차 이하 전체 포함) 주차는 "허브/라인 체계
//     도입 이전" 레거시 기간이다. 레거시 주차는:
//       · 실무 경험 허브에 [통합] 주차 활동 내역 라인 1개만 존재한다
//         (LEGACY_UNIFIED_LINE_NAME 마스터, slot 1, line_code 'EXBS-…' = common).
//       · 실무 정보/역량/경력 허브에는 라인이 없다 (placeholder/fold/패딩 미적용).
//       · 주차 성장 verdict 는 3슬롯 규칙이 아니라 통합 라인 1개 기준
//         (타깃 존재 + 평점 4점 이상/미평가 → pass, 평점 ≤3 → fail,
//          개설 + 미배정 → fail, 미개설 → not_applicable).
//   - 공통: 진행 중(running)·집계 중(tallying = 미공표) 주차에는 placeholder fail 선반영 금지 —
//     마감/판정 완료(공표) 주차에만 fail. 그 전에는 해당 없음(void)으로 둔다.
//   (구: 2026-06-08 = 2026-spring W15, 테스터 전 주차 — 2026-06-05 레거시 통합 정책으로 대체.)
// ─────────────────────────────────────────────────────────────────────
export const CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM = "2026-06-29";

// 테스트 시즌 시뮬레이션 override — 레거시 경계를 과거로 밀어 전 주차를 여름 정책으로 처리한다.
//   mode=test + 검증된 test_user_markers 유저 한정, live compute 전용(운영/snapshot 저장 경로 무관).
export const TEST_SUMMER_SIM_EFFECTIVE_FROM = "1970-01-01";

// 레거시(허브 도입 전) 주차 판별 — start_date < effectiveFrom(기본 2026 여름 W1).
//   effectiveFrom 을 과거로 오버라이드하면 전 주차가 비레거시(여름)로 전환(테스트 시뮬레이션).
export function isLegacyUnifiedWeekStart(
  startDate: string,
  effectiveFrom: string = CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
): boolean {
  return startDate < effectiveFrom;
}

// 레거시 통합 라인 식별자 (마스터 line_name 고정 매칭).
//   마스터: cluster4_experience_line_masters (slot 1 / line_code 'EXBS-UN0000' / org null —
//   라인 line_code 'EXBS-…' 의 BS 토큰이 common 노출을 보장한다).
export const LEGACY_UNIFIED_LINE_NAME = "[통합] 주차 활동 내역";

// 통합 마스터 id 룩업 (모듈 캐시 — 마스터는 마이그레이션으로 1회 생성되는 고정 행).
let legacyUnifiedMasterIdCache: string | null | undefined;
export async function fetchLegacyUnifiedMasterId(): Promise<string | null> {
  if (legacyUnifiedMasterIdCache !== undefined) return legacyUnifiedMasterIdCache;
  // (2E-4) registrations-first — 연결 행의 bridged_master_id(=마스터 id 체계 유지).
  // 미연결이면 기존 마스터 line_name 검색으로 fallback.
  const fromReg = await findExperienceMasterIdByLineNameRegFirst(LEGACY_UNIFIED_LINE_NAME);
  if (fromReg) {
    legacyUnifiedMasterIdCache = fromReg;
    return legacyUnifiedMasterIdCache;
  }
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[lineAvailability] legacy unified master lookup failed", {
      message: error.message,
    });
    return null; // 캐시하지 않음 — 다음 호출에서 재시도
  }
  legacyUnifiedMasterIdCache = (data as { id: string } | null)?.id ?? null;
  return legacyUnifiedMasterIdCache;
}

export const EXPERIENCE_SLOT_CATEGORY: Record<
  1 | 2 | 3 | 4 | 5,
  Cluster4ExperienceCategory
> = {
  1: "derivation",
  2: "analysis",
  3: "evaluation",
  4: "extension",
  5: "management",
};

// ─────────────────────────────────────────────────────────────────────
// 관리(5) 슬롯 단계 게이트 (2026-06-04 보강 — "총 N개" 표시 칸 수 정합):
//   고객앱 Cluster4CardContent 는 membership_level 을 한국어 단계 프리픽스("일반"/"심화"/
//   "운영진")로 환원해 심화·운영진만 관리(5) 슬롯을 열고, 일반/미확정은 잠금(카드 미노출)한다.
//   백엔드가 잠금 사용자에게 관리 슬롯 라인을 fail 로 분모 A 에 넣으면 "화면 카드 1개 ·
//   헤더 총 2개" 식 불일치가 난다 → 라인 칸·분모 양쪽에 동일 게이트를 적용한다.
//   (잠금 사용자의 관리 슬롯 = 해당 없음(not_applicable) → 분모 제외 · 칸 보이드.)
// ─────────────────────────────────────────────────────────────────────
export const EXPERIENCE_MANAGEMENT_SLOT_ORDER = 5;

// 고객앱 EXP_MEMBERSHIP_ROLE_KOREAN(코드형 level → 한국어 라벨) 과 동일 집합 — 프리픽스만 사용.
const MEMBERSHIP_LEVEL_STAGE: Record<string, "일반" | "심화" | "운영진"> = {
  crew: "일반",
  crew_regular: "일반",
  crew_normal: "일반",
  crew_advanced: "심화",
  crew_partleader: "심화",
  crew_advanced_part_leader: "심화",
  part_leader: "심화",
  crew_agent: "심화",
  crew_advanced_agent: "심화",
  admin: "운영진",
  admin_team_leader: "운영진",
  crew_team_leader: "운영진",
  admin_ambassador: "운영진",
  crew_ambassador: "운영진",
  operations_ambassador: "운영진",
};

export function isManagementSlotOpenForLevel(
  membershipLevel: string | null,
): boolean {
  const raw = (membershipLevel ?? "").trim();
  if (!raw) return false; // 미확정 → 잠금(보수적) — 고객앱과 동일
  const mapped = MEMBERSHIP_LEVEL_STAGE[raw] ?? raw;
  const prefix = mapped.split("(")[0] ?? "";
  return prefix.startsWith("심화") || prefix.startsWith("운영진");
}

// membership 선택은 고객앱/pickBestMembership 동일 규칙(team_name 보유 행 > is_current,
// 같은 등급은 updated_at 최신). 조회 실패 시 잠금(false) 폴백 — 분모 과대 방지(fail-closed).
export async function fetchManagementSlotOpen(
  profileUserId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("user_memberships")
    .select("membership_level,team_name,is_current,updated_at")
    .eq("user_id", profileUserId);
  if (error) {
    console.warn("[cluster4/lineAvailability] user_memberships lookup failed", {
      message: error.message,
    });
    return false;
  }
  type Row = {
    membership_level: string | null;
    team_name: string | null;
    is_current: boolean | null;
    updated_at: string | null;
  };
  const rank = (r: Row): number => {
    const cur = Boolean(r.is_current);
    const team = typeof r.team_name === "string" && r.team_name.trim() !== "";
    if (cur && team) return 0;
    if (team) return 1;
    if (cur) return 2;
    return 3;
  };
  const best = ((data ?? []) as Row[]).slice().sort((a, b) => {
    const rankDelta = rank(a) - rank(b);
    if (rankDelta !== 0) return rankDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
  return isManagementSlotOpenForLevel(best?.membership_level ?? null);
}

export type LineCategory = "info" | "ability" | "experience" | "career";

export type WeekLineAvailability = {
  info: number;
  ability: number;
  experience: number;
  career: number;
};

export const ABILITY_AVAILABLE = 1;

const EXPERIENCE_AVAILABLE: Record<string, number> = {
  encre: 2,
  oranke: 2,
  phalanx: 2,
};

export function getExperienceAvailable(org: OrganizationSlug | null): number {
  if (!org) return 2;
  return EXPERIENCE_AVAILABLE[org] ?? 2;
}

// 실무 경력 칸 수 (2026-06-04 정책: 항상 6개 칸 표시 — 개설 안 된 칸은 보이드).
// 분모 cap 도 표시 칸 수와 동일한 6 으로 맞춘다 (구 5).
export const CAREER_DISPLAY_CAP = 6;

export async function fetchInfoLineCountsByWeek(
  userId: string,
  weekIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "info")
    .eq("is_active", true);

  const lineIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (lineIds.length === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  if (targets) {
    for (const t of targets as { week_id: string }[]) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// 강화율 분모 A(experience) = 그 주차에 해당 사용자가 배정된 active experience 라인 target 수.
// info 의 fetchInfoLineCountsByWeek 와 동일 방식(part_type 만 'experience'). user_activity_details 미사용.
// 상수(getExperienceAvailable) 대신 이 동적 배정 수를 분모로 쓴다.
export async function fetchExperienceLineCountsByWeek(
  userId: string,
  weekIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "experience")
    .eq("is_active", true);

  const lineIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (lineIds.length === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  if (targets) {
    for (const t of targets as { week_id: string }[]) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// 강화율 분모 A(competency) = 그 주차에 해당 사용자가 배정된 active competency 라인 target 수.
// info 의 fetchInfoLineCountsByWeek / experience 의 fetchExperienceLineCountsByWeek 와 동일 방식
// (part_type 만 'competency'). user_activity_details 미사용.
// 상수(ABILITY_AVAILABLE=1) 대신 이 동적 배정 수를 분모로 쓴다 — 0개 배정이면 0, 2개면 2.
export async function fetchCompetencyLineCountsByWeek(
  userId: string,
  weekIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "competency")
    .eq("is_active", true);

  const lineIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (lineIds.length === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  if (targets) {
    for (const t of targets as { week_id: string }[]) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

export async function fetchCareerProjectCountsByWeek(
  weekIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data } = await supabaseAdmin
    .from("career_project_weeks")
    .select("week_id")
    .eq("is_active", true)
    .in("week_id", weekIds);

  if (data) {
    for (const r of data as { week_id: string }[]) {
      result.set(r.week_id, (result.get(r.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// 강화율 분모 A(career, P1) = 그 주차에 해당 사용자가 배정된 active career 라인 target 수.
// info/experience/competency 와 동일 방식(part_type 만 'career'). user_activity_details 미사용.
// (구: fetchCareerProjectCountsByWeek = career_project_weeks 프로젝트 개설 수 — "실제 라인" 아님.)
export async function fetchCareerLineCountsByWeek(
  userId: string,
  weekIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "career")
    .eq("is_active", true);

  const lineIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (lineIds.length === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  if (targets) {
    for (const t of targets as { week_id: string }[]) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// 강화율 분자 B(career, P1) = 그 주차 사용자 career 라인 중 강화 success 수.
// success = 마감(submission_closes_at) 지남 + grade S/A/B/C(4점 이상). D(2점)·미평가·미제출은 제외.
// 즉 per-line enhancementStatus==="success" 와 동일 기준(평점 반영). user_activity_details 미사용.
export async function fetchCareerLineSuccessCountsByWeek(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at")
    .eq("part_type", "career")
    .eq("is_active", true);

  const closesById = new Map<string, string>();
  for (const l of (lines ?? []) as { id: string; submission_closes_at: string }[]) {
    closesById.set(l.id, l.submission_closes_at);
  }
  if (closesById.size === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,week_id,line_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", Array.from(closesById.keys()))
    .in("week_id", weekIds);

  const targetRows = (targets ?? []) as { id: string; week_id: string; line_id: string }[];
  // 마감 지난 타깃만 success 후보. 그 중 grade C 이상인 것을 센다.
  const deadlinePassed = targetRows.filter((t) => {
    const closes = closesById.get(t.line_id);
    return closes && new Date(closes).getTime() < now;
  });
  if (deadlinePassed.length === 0) return result;

  const { data: evals } = await supabaseAdmin
    .from("cluster4_career_line_evaluations")
    .select("line_target_id,grade")
    .eq("user_id", userId)
    .in("line_target_id", deadlinePassed.map((t) => t.id));
  const gradeByTarget = new Map<string, CareerGrade>();
  for (const e of (evals ?? []) as { line_target_id: string; grade: CareerGrade }[]) {
    gradeByTarget.set(e.line_target_id, e.grade);
  }

  for (const t of deadlinePassed) {
    const grade = gradeByTarget.get(t.id);
    // success = grade 존재 + 강화 실패(D) 아님 (= S/A/B/C).
    if (grade && !isCareerGradeFail(grade)) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// BULK: weekly-cards 1회 호출에 필요한 8개 맵을 묶어 한 번에 산정.
//
// 기존 computeWeeklyCards 는 part 별로 fetchInfoLineCountsByWeek /
// fetchExperienceLineCountsByWeek / fetchCompetencyLineCountsByWeek /
// fetchInfoLineSuccessCountsByWeek / fetchLineSuccessCountsByWeek×2 /
// fetchCareerLineSuccessCountsByWeek / fetchCareerLineCountsByWeek 를 각각 호출했다.
// → cluster4_lines 9회 + cluster4_line_targets 8회 = 약 17~20 쿼리.
//
// 이 함수는 동일 결과를 cluster4_lines 1회 + cluster4_line_targets 1회
// (+ career grade 1회) = 최대 3 쿼리로 계산한다. 의미는 기존 함수들과 1:1 동일:
//   - 카운트 맵: 그 주차 사용자 active 라인 target 수 (part 별).
//   - success 맵(info/ability/experience): target + submission_closes_at 마감(now 기준), 제출 무관.
//   - careerSuccess 맵: 마감 + grade C이상(S/A/B/C). D/미평가/미제출 제외.
// (기존 fetch* 함수는 cluster1ResumeData / smoke 스크립트가 계속 사용 → 보존.)
// ─────────────────────────────────────────────────────────────────────
export type WeeklyCardLineAggregates = {
  infoLineMap: Map<string, number>;
  experienceLineMap: Map<string, number>;
  competencyLineMap: Map<string, number>;
  careerLineMap: Map<string, number>;
  infoSuccessMap: Map<string, number>;
  abilitySuccessMap: Map<string, number>; // competency success
  experienceSuccessMap: Map<string, number>;
  careerSuccessMap: Map<string, number>;
};

function emptyWeeklyCardLineAggregates(): WeeklyCardLineAggregates {
  return {
    infoLineMap: new Map(),
    experienceLineMap: new Map(),
    competencyLineMap: new Map(),
    careerLineMap: new Map(),
    infoSuccessMap: new Map(),
    abilitySuccessMap: new Map(),
    experienceSuccessMap: new Map(),
    careerSuccessMap: new Map(),
  };
}

export async function fetchWeeklyCardLineAggregates(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
): Promise<WeeklyCardLineAggregates> {
  const agg = emptyWeeklyCardLineAggregates();
  if (weekIds.length === 0) return agg;

  // Q1: 해당 유저의 주차별 라인 타깃 (전 part 한 번에) — part 별 반복 조회를 1회로.
  // 유저+주차로 한정되어 행 수가 작다(암묵적 1000행 상한 무관). 먼저 타깃을 받아
  // 필요한 line_id 만 추려 Q2 를 좁힌다.
  const { data: targetRows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id,week_id,line_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("week_id", weekIds);
  const targets = (targetRows ?? []) as {
    id: string;
    week_id: string;
    line_id: string;
  }[];
  if (targets.length === 0) return agg;

  // Q2: 그 타깃들이 가리키는 active cluster4_lines 만 (part_type + 마감). is_active 필터로
  // 비활성 라인은 lineById 에 없게 되어 아래 루프에서 자동 제외(기존 함수와 동일 기준).
  const targetLineIds = [...new Set(targets.map((t) => t.line_id))];
  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,submission_closes_at")
    .in("id", targetLineIds)
    .eq("is_active", true);
  const lines = (lineRows ?? []) as {
    id: string;
    part_type: string;
    submission_closes_at: string | null;
  }[];
  if (lines.length === 0) return agg;
  const lineById = new Map<
    string,
    { partType: string; closesAt: string | null }
  >();
  for (const l of lines) {
    lineById.set(l.id, { partType: l.part_type, closesAt: l.submission_closes_at });
  }

  const bump = (m: Map<string, number>, k: string) =>
    m.set(k, (m.get(k) ?? 0) + 1);
  const careerDeadlinePassed: { id: string; week_id: string }[] = [];
  // experience success 는 마감 + 평점 rating>3 (또는 미평가) → 마감 지난 experience 타깃만 평점 조회 후보.
  // rating<=3 은 강화 실패(per-line enhancementStatus=fail)이므로 분자 B 에서 제외한다(career grade D 와 동일 취지).
  const experienceDeadlinePassed: { id: string; week_id: string }[] = [];

  for (const t of targets) {
    const line = lineById.get(t.line_id);
    if (!line) continue;
    const deadlinePassed =
      Boolean(line.closesAt) &&
      new Date(line.closesAt as string).getTime() < now;
    switch (line.partType) {
      case "info":
        bump(agg.infoLineMap, t.week_id);
        if (deadlinePassed) bump(agg.infoSuccessMap, t.week_id);
        break;
      case "experience":
        bump(agg.experienceLineMap, t.week_id);
        // success 여부는 평점 조회 후 결정(rating<=3 제외). 마감 지난 타깃만 후보.
        if (deadlinePassed) experienceDeadlinePassed.push({ id: t.id, week_id: t.week_id });
        break;
      case "competency":
        bump(agg.competencyLineMap, t.week_id);
        if (deadlinePassed) bump(agg.abilitySuccessMap, t.week_id);
        break;
      case "career":
        bump(agg.careerLineMap, t.week_id);
        // career success 는 마감 + grade C이상 → 마감 지난 타깃만 grade 조회 후보.
        if (deadlinePassed) careerDeadlinePassed.push({ id: t.id, week_id: t.week_id });
        break;
    }
  }

  // Q3b: experience success 평점 (마감 지난 experience 타깃에 한해). rating<=3(EXPERIENCE_RATING_FAIL_THRESHOLD)
  //   은 강화 실패로 분자 제외. rating 미평가/>3 은 success(기존 마감 기준 유지). 후보 없으면 쿼리 생략.
  if (experienceDeadlinePassed.length > 0) {
    const { data: expEvals } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,rating")
      .eq("user_id", userId)
      .in("line_target_id", experienceDeadlinePassed.map((t) => t.id));
    const ratingByTarget = new Map<string, number>();
    for (const e of (expEvals ?? []) as { line_target_id: string; rating: number }[]) {
      ratingByTarget.set(e.line_target_id, e.rating);
    }
    for (const t of experienceDeadlinePassed) {
      const rating = ratingByTarget.get(t.id);
      // rating<=3 → 강화 실패(분자 제외). 미평가(undefined)·rating>3 → success.
      if (rating != null && rating <= EXPERIENCE_RATING_FAIL_THRESHOLD) continue;
      bump(agg.experienceSuccessMap, t.week_id);
    }
  }

  // Q3: career success grade (마감 지난 career 타깃에 한해). 후보 없으면 쿼리 자체를 생략.
  if (careerDeadlinePassed.length > 0) {
    const { data: evals } = await supabaseAdmin
      .from("cluster4_career_line_evaluations")
      .select("line_target_id,grade")
      .eq("user_id", userId)
      .in(
        "line_target_id",
        careerDeadlinePassed.map((t) => t.id),
      );
    const gradeByTarget = new Map<string, CareerGrade>();
    for (const e of (evals ?? []) as {
      line_target_id: string;
      grade: CareerGrade;
    }[]) {
      gradeByTarget.set(e.line_target_id, e.grade);
    }
    for (const t of careerDeadlinePassed) {
      const grade = gradeByTarget.get(t.id);
      // success = grade 존재 + 강화 실패(D) 아님 (= S/A/B/C).
      if (grade && !isCareerGradeFail(grade)) bump(agg.careerSuccessMap, t.week_id);
    }
  }

  return agg;
}

export function buildWeekAvailability(
  weekId: string | null,
  infoMap: Map<string, number>,
  careerMap: Map<string, number>,
  organization: OrganizationSlug | null,
  experienceMap?: Map<string, number>,
  competencyMap?: Map<string, number>,
  // P1: career 분모를 "사용자 배정 라인 수"(per-user)로 동적화. 미제공(이력서 등 레거시 호출) 시
  // careerMap(career_project_weeks 기반)으로 폴백 — 하위호환 유지(experience/competency 와 동일 패턴).
  careerUserMap?: Map<string, number>,
): WeekLineAvailability {
  const info = weekId ? (infoMap.get(weekId) ?? 0) : 0;
  const rawCareer = weekId
    ? careerUserMap
      ? careerUserMap.get(weekId) ?? 0
      : careerMap.get(weekId) ?? 0
    : 0;
  // experience A(분모): 그 주차에 사용자에게 배정된 active experience 라인 target 수.
  // experienceMap 제공 시 동적 배정 수(info 와 동일 기준)를 쓰고, 미제공(레거시 호출) 시
  // 기존 조직별 상수로 폴백한다 — 하위호환 유지.
  const experience = experienceMap
    ? weekId
      ? experienceMap.get(weekId) ?? 0
      : 0
    : getExperienceAvailable(organization);
  // competency(ability) A(분모): 그 주차에 사용자에게 배정된 active competency 라인 target 수.
  // competencyMap 제공 시 동적 배정 수(info/experience 와 동일 기준)를 쓰고, 미제공(레거시 호출,
  // 예: 이력서 cluster1ResumeData) 시 기존 상수 ABILITY_AVAILABLE 로 폴백한다 — 하위호환 유지.
  const ability = competencyMap
    ? weekId
      ? competencyMap.get(weekId) ?? 0
      : 0
    : ABILITY_AVAILABLE;
  return {
    info,
    ability,
    experience,
    career: Math.min(CAREER_DISPLAY_CAP, rawCareer),
  };
}

export function totalAvailable(a: WeekLineAvailability): number {
  return a.info + a.ability + a.experience + a.career;
}

// 강화율(%) — Math.round 기준(확정 정책 2026-05-30). available 0 이면 0.
// info 포함 4허브·주차 종합·시즌 집계 모두 이 함수로 동일 반올림한다.
export function roundGrowthRate(completed: number, available: number): number {
  return available === 0 ? 0 : Math.round((completed / available) * 100);
}

// 그 주차에 해당 사용자가 배정된 active info 라인 중 "강화 성공"(마감 지남) 수.
// 강화율 B = success 개수. 강화상태 success(target+마감)와 동일 기준 — 제출 여부 무관.
export async function fetchInfoLineSuccessCountsByWeek(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at")
    .eq("part_type", "info")
    .eq("is_active", true);

  const closesById = new Map<string, string>();
  for (const l of (lines ?? []) as { id: string; submission_closes_at: string }[]) {
    closesById.set(l.id, l.submission_closes_at);
  }
  if (closesById.size === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id,line_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", Array.from(closesById.keys()))
    .in("week_id", weekIds);

  for (const t of (targets ?? []) as { week_id: string; line_id: string }[]) {
    const closes = closesById.get(t.line_id);
    // success = 마감(submission_closes_at) 지남. 제출 유무 무관.
    if (closes && new Date(closes).getTime() < now) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// part별 강화율 분자 B = 그 주차에 사용자가 배정된 active 라인 target 중 "강화 성공"(마감 지남) 수.
// info 의 fetchInfoLineSuccessCountsByWeek 와 동일 기준(target + submission_closes_at 마감, 제출 무관)을
// ability(competency) / experience / career 에도 적용한다. user_activity_details 미사용.
export async function fetchLineSuccessCountsByWeek(
  userId: string,
  weekIds: string[],
  partType: "info" | "competency" | "experience" | "career",
  now: number = Date.now(),
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at")
    .eq("part_type", partType)
    .eq("is_active", true);

  const closesById = new Map<string, string>();
  for (const l of (lines ?? []) as { id: string; submission_closes_at: string }[]) {
    closesById.set(l.id, l.submission_closes_at);
  }
  if (closesById.size === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id,line_id")
    .eq("target_mode", "user")
    .eq("target_user_id", userId)
    .in("line_id", Array.from(closesById.keys()))
    .in("week_id", weekIds);

  for (const t of (targets ?? []) as { week_id: string; line_id: string }[]) {
    const closes = closesById.get(t.line_id);
    // success = 마감(submission_closes_at) 지남. 제출 유무 무관.
    if (closes && new Date(closes).getTime() < now) {
      result.set(t.week_id, (result.get(t.week_id) ?? 0) + 1);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// "라인 개설" 신호 (fail vs not_applicable 구분) — 기준: cluster4_lines 행 존재.
//
// 중요(2026-06-02): cluster4_lines 에는 week_id 가 없다(2026-05-29 마이그레이션 참고).
// 라인의 주차 SoT 는 cluster4_line_targets.week_id 이므로, "그 주차에 라인이 개설됨"은
// "그 주차에 해당 part 의 active 라인을 가리키는 target 행이 (누구든·어느 mode든) 존재"로만
// 표현할 수 있다. 따라서 과거의 target_mode='user' 한정을 제거하고 mode 무관(any target)으로
// 본다 — 이것이 "target(=배정) 존재가 아니라 line 행(=개설 이력) 존재" 기준의 스키마상 구현이다.
//
//   배정(=본인 user target) 없음 + 개설됨(any target 존재) → fail
//   배정 없음 + 미개설(any target 없음)                    → not_applicable
// ─────────────────────────────────────────────────────────────────────

// 단일 part 의 "개설된 주차" 집합. mode 무관(개설 이력 = 행 존재) 기준.
async function fetchOpenWeeksForPart(
  partType: "info" | "experience" | "competency" | "career",
  weekIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (weekIds.length === 0) return result;

  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", partType)
    .eq("is_active", true);
  const lineIds = (lines ?? []).map((l: { id: string }) => l.id);
  if (lineIds.length === 0) return result;

  const { data: targets } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  for (const t of (targets ?? []) as { week_id: string }[]) {
    result.add(t.week_id);
  }
  return result;
}

// 그 주차에 info 라인이 (누구든) 개설됐는지 — fail vs not_applicable 구분 신호.
export async function fetchWeeksWithAnyInfoLine(
  weekIds: string[],
): Promise<Set<string>> {
  return fetchOpenWeeksForPart("info", weekIds);
}

// 그 주차에 experience 라인이 (누구든) 개설됐는지.
export async function fetchWeeksWithAnyExperienceLine(
  weekIds: string[],
): Promise<Set<string>> {
  return fetchOpenWeeksForPart("experience", weekIds);
}

// 그 주차에 competency(실무 역량) 라인이 (누구든) 개설됐는지. (2026-06-02 신설)
// 기존 "competency 는 항상 fail" 정책 폐기 → 개설됨(=행 존재)일 때만 미배정 fail, 미개설은 not_applicable.
export async function fetchWeeksWithAnyCompetencyLine(
  weekIds: string[],
): Promise<Set<string>> {
  return fetchOpenWeeksForPart("competency", weekIds);
}

// ─────────────────────────────────────────────────────────────────────
// BULK: info/experience/competency 의 "주차별 개설 라인 수(distinct line_id)"를
// cluster4_lines 1회 + cluster4_line_targets 1회 = 2 쿼리로 산정한다.
//
// 강화율 분모 A 의 정의(2026-06-02):
//   A_part(주차) = 그 주차에 개설된(=any target 존재) distinct 라인 수.
//   - 본인 배정 라인 ⊆ 개설 라인 이므로, "개설됐는데 본인 미배정"인 라인이 곧 synthetic fail.
//     (A 에는 포함, 분자 B 에는 미포함 → 강화 실패 1건.)
//   - 미개설(개설 라인 0)이면 A=0 → not_applicable(분모 제외).
// career 는 제외 — career 의 "개설+미배정"은 미선발(not_applicable)이므로 A 에 넣지 않는다
//   (career A 는 본인 배정 수 = careerLineMap 그대로 사용).
// ─────────────────────────────────────────────────────────────────────
export type OpenLinesByPart = {
  info: Map<string, number>;
  experience: Map<string, number>;
  competency: Map<string, number>;
  // 주차별 "개설된 experience 슬롯(slot_order)" 집합 (2026-06-04).
  // 분모 A(experience) = 개설 distinct 라인 수 + |{1,2,3,5} ∖ 개설 슬롯| (미개설 필수 슬롯 = fail 칸).
  experienceOpenSlots: Map<string, Set<number>>;
  // 주차별 "개설된 관리(5) 슬롯 distinct 라인 수" — 관리 슬롯 잠금 사용자의 분모 차감용.
  experienceManagementLineCount: Map<string, number>;
};

export async function fetchWeeksWithOpenLinesByPart(
  weekIds: string[],
): Promise<OpenLinesByPart> {
  const empty: OpenLinesByPart = {
    info: new Map(),
    experience: new Map(),
    competency: new Map(),
    experienceOpenSlots: new Map(),
    experienceManagementLineCount: new Map(),
  };
  if (weekIds.length === 0) return empty;

  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,experience_line_master_id")
    .in("part_type", ["info", "experience", "competency"])
    .eq("is_active", true);
  const lines = (lineRows ?? []) as {
    id: string;
    part_type: string;
    experience_line_master_id: string | null;
  }[];
  if (lines.length === 0) return empty;

  const partByLineId = new Map<string, string>();
  for (const l of lines) partByLineId.set(l.id, l.part_type);

  // experience 라인 → slot_order (마스터 룩업). 실패/미분류 라인은 슬롯 미상으로 두고
  // distinct 라인 수에만 반영한다 (개설 슬롯 집합에는 미포함).
  const masterIdByLineId = new Map<string, string>();
  for (const l of lines) {
    if (l.part_type === "experience" && l.experience_line_master_id) {
      masterIdByLineId.set(l.id, l.experience_line_master_id);
    }
  }
  // (2E-4) registrations-first slot 룩업 (미커버 id 는 헬퍼 내부 마스터 fallback) — 결과 등가.
  const masterIds = [...new Set(masterIdByLineId.values())];
  const slotByMasterId = await getExperienceSlotsByMasterIdsRegFirst(masterIds);

  // ⚠ 전수 페이지네이션(안정 정렬 id asc) — PostgREST 기본 1000행 cap 절단 방지.
  //   절단되면 분모 A(개설 distinct 라인 수)가 재계산 시점마다 비결정적으로 흔들린다
  //   (2026-06-04 실측: 37주차 보유자 매칭 2,765행 > cap).
  //   fetchExperienceRequiredSlotStatusByWeek 와 동일 패턴 — 집계 정책/수식 무변경.
  let targets: { week_id: string; line_id: string }[] = [];
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data: page, error: pageErr } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("week_id,line_id,id")
        .in("line_id", [...partByLineId.keys()])
        .in("week_id", weekIds)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (pageErr) {
        // 기존 동작 보존: 조회 에러는 무시하고 수집분으로 계속(원본도 에러를 무시했음).
        console.warn("[lineAvailability] open-lines targets page fetch failed", {
          from,
          message: pageErr.message,
        });
        break;
      }
      const rows = (page ?? []) as { week_id: string; line_id: string }[];
      targets = targets.concat(rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  // week → part → distinct line_id 집합 (중복 타깃/유저 다수를 1라인으로 접는다).
  const seen = new Map<string, Set<string>>(); // key = `${part}:${week}`
  // week → 관리(5) 슬롯 distinct line_id 집합 (잠금 사용자 분모 차감용).
  const managementSeen = new Map<string, Set<string>>();
  for (const t of targets) {
    const part = partByLineId.get(t.line_id);
    if (part !== "info" && part !== "experience" && part !== "competency") continue;
    // experience 슬롯/관리 게이트 선판정 — 슬롯 미상(master 미연결) 라인은 카드 경로가
    // fail-closed 제외하므로(5슬롯 UI 렌더 불가) 분모 distinct 에서도 제외해 정합 유지(2026-06-04 v13).
    let expSlot: number | undefined;
    if (part === "experience") {
      const masterId = masterIdByLineId.get(t.line_id);
      expSlot = masterId ? slotByMasterId.get(masterId) : undefined;
      if (expSlot == null) continue;
    }
    const key = `${part}:${t.week_id}`;
    let s = seen.get(key);
    if (!s) {
      s = new Set();
      seen.set(key, s);
    }
    s.add(t.line_id);
    // experience 개설 슬롯 집합 갱신.
    if (part === "experience" && expSlot != null) {
      let slots = empty.experienceOpenSlots.get(t.week_id);
      if (!slots) {
        slots = new Set();
        empty.experienceOpenSlots.set(t.week_id, slots);
      }
      slots.add(expSlot);
      if (expSlot === EXPERIENCE_MANAGEMENT_SLOT_ORDER) {
        let mgmt = managementSeen.get(t.week_id);
        if (!mgmt) {
          mgmt = new Set();
          managementSeen.set(t.week_id, mgmt);
        }
        mgmt.add(t.line_id);
      }
    }
  }
  for (const [week, s] of managementSeen) {
    empty.experienceManagementLineCount.set(week, s.size);
  }
  for (const [key, s] of seen) {
    const [part, week] = key.split(":") as [
      "info" | "experience" | "competency",
      string,
    ];
    empty[part].set(week, s.size);
  }
  return empty;
}

// ─────────────────────────────────────────────────────────────────────
// 실무 경험 필수 슬롯(도출1·분석2·평가3) 기준 주차 성장 실패 판정 (2026-05-30)
//
// 정책 (사용자 확정):
//   - 필수 슬롯 = experience_slot_order 1(derivation)/2(analysis)/3(evaluation).
//     확장(4)/관리(5)는 판정에서 제외.
//   - 각 슬롯의 enhancementStatus 는 computeCluster4Enhancement 그대로 사용한다
//     (success = 배정+마감 / pending = 배정+마감 전 / fail = 미배정인데 슬롯 라인 개설됨 /
//      not_applicable = 슬롯 라인 미개설). 제출 여부는 보지 않는다.
//   - 주차 verdict:
//       하나라도 fail            → fail   (성장 실패)
//       셋 다 not_applicable     → not_applicable (실패 규칙 미적용 → 기존 status 유지)
//       fail 없고 하나라도 pending → pending (진행/대기 유지)
//       나머지                   → pass
// ─────────────────────────────────────────────────────────────────────

export type ExperienceRequiredSlotCategory =
  | "derivation"
  | "analysis"
  | "evaluation";

export type ExperienceRequiredSlotStatus = {
  slotOrder: 1 | 2 | 3;
  category: ExperienceRequiredSlotCategory;
  enhancementStatus: Cluster4EnhancementStatus;
};

export type ExperienceGrowthVerdictStatus =
  | "pass"
  | "fail"
  | "pending"
  | "not_applicable";

// 주차 인정 check 게이트 (2026-06-05 정책 정정 — 레거시 통합 라인 전용).
//   주차 성공 = 강화 성공(평점 ≥4/미평가) AND earned(check) >= required(기준값).
//   passed=false && enforced=true 면 verdict.status 가 fail 로 강등되지만 슬롯
//   enhancementStatus(강화)는 success 그대로 유지된다 — "강화 성공 + 주차 실패" 분리 표시 근거.
//   enforced = user_weekly_points.checks_migrated (행 단위 이관 provenance). false/행 부재 =
//   미이관 → 기존 결과 보존(강등 없음). 이관 파이프라인이 행을 true 로 기록하면 그
//   (사용자, 주차)만 별도 코드 수정 없이 자동 enforce.
export type WeekCheckGate = {
  required: number; // 적용된 기준값 (weeks.check_threshold ?? DEFAULT_WEEK_CHECK_THRESHOLD)
  earned: number; // 그 주차 본인 point.check (user_weekly_points.points, 행 없으면 0)
  passed: boolean;
  enforced: boolean; // 강등 적용 여부 (check 데이터 이관 스케일 감지 시 true)
};

export type ExperienceGrowthVerdict = {
  status: ExperienceGrowthVerdictStatus;
  requiredSlots: ExperienceRequiredSlotStatus[];
  failedSlotOrders: number[];
  // 레거시 통합 라인 주차에서 check 게이트가 평가된 경우에만 채워진다(append-only).
  checkGate?: WeekCheckGate | null;
};

const REQUIRED_SLOTS: ReadonlyArray<{
  slotOrder: 1 | 2 | 3;
  category: ExperienceRequiredSlotCategory;
}> = [
  { slotOrder: 1, category: "derivation" },
  { slotOrder: 2, category: "analysis" },
  { slotOrder: 3, category: "evaluation" },
];

// 슬롯 1/2/3 강화상태 → 주차 verdict 환원 (순수 함수 — 프론트 재계산 없이 백엔드 SoT,
// 스모크에서 DB 없이 단위 검증 가능).
export function reduceExperienceRequiredSlotVerdict(
  slots: ExperienceRequiredSlotStatus[],
): ExperienceGrowthVerdict {
  const statuses = slots.map((s) => s.enhancementStatus);
  const failedSlotOrders = slots
    .filter((s) => s.enhancementStatus === "fail")
    .map((s) => s.slotOrder);

  let status: ExperienceGrowthVerdictStatus;
  if (statuses.some((s) => s === "fail")) status = "fail";
  else if (statuses.every((s) => s === "not_applicable"))
    status = "not_applicable";
  else if (statuses.some((s) => s === "pending")) status = "pending";
  else status = "pass";

  return { status, requiredSlots: slots, failedSlotOrders };
}

// verdict 가 주차 성장 상태(resultStatus)에 fail 로 반영되어야 하는가.
//   - verdict.status === "fail" 일 때만
//   - 휴식(personal/official_rest)·진행(running)·집계(tallying = 현재 주차) 주차는 제외
export function shouldApplyExperienceFail(
  verdictStatus: ExperienceGrowthVerdictStatus,
  baseStatus:
    | "success"
    | "fail"
    | "personal_rest"
    | "official_rest"
    | "running"
    | "tallying",
): boolean {
  if (verdictStatus !== "fail") return false;
  return baseStatus === "success" || baseStatus === "fail";
}

// DB 영속화 가드 (순수): user_week_statuses 행을 success → fail 로 갱신할지.
//   - 현재 status 가 "success" 일 때만 (rest/fail 은 절대 변경 불가 — 물리적 방어와 일치)
//   - verdict.status === "fail" 일 때만 (pending/pass/not_applicable 은 미반영)
//   - 현재주(running, DB 미반영 상태)는 제외
// sync 함수와 동일 기준을 공유해 화면(override)·DB(sync)가 어긋나지 않게 한다.
export function shouldSyncWeekStatusToFail(
  currentStatus: string,
  verdictStatus: ExperienceGrowthVerdictStatus,
  isCurrentWeek: boolean,
): boolean {
  return (
    currentStatus === "success" &&
    verdictStatus === "fail" &&
    !isCurrentWeek
  );
}

// ─────────────────────────────────────────────────────────────────────
// 레거시(허브 도입 전) 주차의 통합 라인 상태 (2026-06-05 레거시 통합 정책).
//   주차별로: 통합 라인 개설 여부(any target) / 본인 타깃 / 마감 경과 / 본인 평점.
//   weekly-growth 집계 override + 레거시 주차 verdict 산정의 공용 SoT.
// ─────────────────────────────────────────────────────────────────────
export type LegacyUnifiedWeekState = {
  opened: boolean; // 그 주차에 통합 라인이 개설(any target 존재)됐는가
  hasTarget: boolean; // 본인 user 타깃 존재
  deadlinePassed: boolean; // 통합 라인 마감(submission_closes_at) 경과
  rating: number | null; // 본인 평점 (cluster4_experience_line_evaluations)
  // ── 주차 인정 check 게이트 입력 (2026-06-05 정책 정정) ──
  checkCount: number; // 본인 point.check (user_weekly_points.points, 행 없으면 0)
  checkThreshold: number; // 적용 기준값 (weeks.check_threshold ?? DEFAULT_WEEK_CHECK_THRESHOLD)
  // 이 (사용자, 주차) 행의 check 가 정식 이관된 값인가 = user_weekly_points.checks_migrated.
  // 행 부재/false = 미이관 → 게이트 미강제(기존 결과 보존, fail-safe). 크기 추론 아님 —
  // 행 단위 provenance 라 일부 사용자/일부 시즌만 이관돼도 정확히 그 범위에만 적용된다.
  checkDataMigrated: boolean;
};

// 사용자 organization_slug 단건 조회 (org_week_thresholds 해석용).
//   user_profiles.organization_slug — 이관 source_system 매핑(hrdb→encre·oranke→oranke·
//   olympus→phalanx, lib/pmsMigration.ts)으로 기록된 값이 SoT. 과거 주차 조직 이력은
//   추적하지 않는다(2026-06-07 정책 확정). 조회 실패/null = 공통 폴백(현행 동작).
async function fetchUserOrganizationSlug(
  userId: string,
): Promise<OrganizationSlug | null> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[lineAvailability] organization_slug fetch failed — common fallback", {
      message: error.message,
    });
    return null;
  }
  const slug = (data as { organization_slug: string | null } | null)
    ?.organization_slug;
  return isOrganizationSlug(slug) ? slug : null;
}

export async function fetchLegacyUnifiedExperienceByWeek(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
  opts: {
    // 호출부가 이미 보유한 organization_slug (weekly-cards 파이프라인 등) — 전달 시 재조회 생략.
    // undefined = 내부 조회 / null = 무소속(공통 폴백 확정, 조회 생략).
    organizationSlug?: OrganizationSlug | null;
  } = {},
): Promise<Map<string, LegacyUnifiedWeekState>> {
  const result = new Map<string, LegacyUnifiedWeekState>();
  if (weekIds.length === 0) return result;
  const masterId = await fetchLegacyUnifiedMasterId();
  if (!masterId) return result; // 마스터 미생성 → 전부 미개설(not_applicable) 취급

  const { data: lineRows, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at")
    .eq("part_type", "experience")
    .eq("experience_line_master_id", masterId)
    .eq("is_active", true);
  if (lineErr || !lineRows || lineRows.length === 0) return result;
  const closesByLineId = new Map<string, string | null>();
  for (const l of lineRows as { id: string; submission_closes_at: string | null }[]) {
    closesByLineId.set(l.id, l.submission_closes_at);
  }

  // 타깃 전수 페이지네이션 (개설 신호 = any target / 본인 타깃 분리 집계).
  const ensure = (week: string): LegacyUnifiedWeekState => {
    let s = result.get(week);
    if (!s) {
      s = {
        opened: false,
        hasTarget: false,
        deadlinePassed: false,
        rating: null,
        checkCount: 0,
        checkThreshold: DEFAULT_WEEK_CHECK_THRESHOLD,
        checkDataMigrated: false,
      };
      result.set(week, s);
    }
    return s;
  };
  const ownTargetWeekById = new Map<string, string>(); // own target id → week_id
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data: page, error: pageErr } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("id,week_id,line_id,target_mode,target_user_id")
        .in("line_id", [...closesByLineId.keys()])
        .in("week_id", weekIds)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (pageErr) {
        console.warn("[lineAvailability] legacy unified targets page fetch failed", {
          from,
          message: pageErr.message,
        });
        break;
      }
      const rows = (page ?? []) as {
        id: string;
        week_id: string;
        line_id: string;
        target_mode: string;
        target_user_id: string | null;
      }[];
      for (const t of rows) {
        const s = ensure(t.week_id);
        s.opened = true;
        if (t.target_mode === "user" && t.target_user_id === userId) {
          s.hasTarget = true;
          const closes = closesByLineId.get(t.line_id);
          if (closes && new Date(closes).getTime() < now) s.deadlinePassed = true;
          ownTargetWeekById.set(t.id, t.week_id);
        }
      }
      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  // 본인 평점 (통합 라인 타깃 한정).
  if (ownTargetWeekById.size > 0) {
    const ids = [...ownTargetWeekById.keys()];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data: evals } = await supabaseAdmin
        .from("cluster4_experience_line_evaluations")
        .select("line_target_id,rating")
        .eq("user_id", userId)
        .in("line_target_id", chunk);
      for (const e of (evals ?? []) as { line_target_id: string; rating: number }[]) {
        const week = ownTargetWeekById.get(e.line_target_id);
        if (!week) continue;
        const s = ensure(week);
        s.rating = e.rating;
      }
    }
  }

  // ── 주차 인정 check 게이트 입력 (2026-06-05 정책 정정) ──
  //   weeks.check_threshold(NULL=기본값) + user_weekly_points.points(ISO year/week 매칭).
  //   상태가 만들어진 주차(개설 주차)에만 채운다 — 미개설(not_applicable) 주차는 게이트 미적용.
  if (result.size > 0) {
    type WeekMetaRow = {
      id: string;
      iso_year: number | null;
      iso_week: number | null;
      check_threshold?: number | null;
    };
    let weekMeta: WeekMetaRow[] = [];
    {
      // check_threshold 컬럼 미적용 DB(마이그레이션 전) 방어: 실패 시 컬럼 없이 재조회.
      const ids = [...result.keys()];
      const { data, error } = await supabaseAdmin
        .from("weeks")
        .select("id,iso_year,iso_week,check_threshold")
        .in("id", ids);
      if (error) {
        console.warn(
          "[lineAvailability] weeks.check_threshold select failed — fallback to default threshold",
          { message: error.message },
        );
        const { data: fallback } = await supabaseAdmin
          .from("weeks")
          .select("id,iso_year,iso_week")
          .in("id", ids);
        weekMeta = (fallback ?? []) as WeekMetaRow[];
      } else {
        weekMeta = (data ?? []) as WeekMetaRow[];
      }
    }

    const isoByWeekId = new Map<string, { year: number; week: number }>();
    for (const w of weekMeta) {
      const s = result.get(w.id);
      if (!s) continue;
      s.checkThreshold =
        w.check_threshold != null && w.check_threshold >= 0
          ? w.check_threshold
          : DEFAULT_WEEK_CHECK_THRESHOLD;
      if (w.iso_year != null && w.iso_week != null) {
        isoByWeekId.set(w.id, { year: w.iso_year, week: w.iso_week });
      }
    }

    // ── 조직별 기준값 오버라이드 (2026-06-07 B안 — org_week_thresholds) ──
    //   해석 순서: org_week_thresholds(week_id, org) → weeks.check_threshold → 기본값(30).
    //   org = user_profiles.organization_slug (source_system 매핑 SoT — Team 파생 금지).
    //   org null/미등록 slug·테이블 미생성(마이그레이션 전)·조회 실패 = 오버라이드 없음
    //   (fail-open — 위에서 채운 공통 폴백 체인 그대로). enforce 여부(checks_migrated)는
    //   본 오버라이드와 무관 — 기준값만 바뀐다.
    {
      const orgSlug =
        opts.organizationSlug !== undefined
          ? opts.organizationSlug
          : await fetchUserOrganizationSlug(userId);
      if (orgSlug && isOrganizationSlug(orgSlug)) {
        const { data: orgRows, error: orgErr } = await supabaseAdmin
          .from("org_week_thresholds")
          .select("week_id,check_threshold")
          .eq("organization_slug", orgSlug)
          .in("week_id", [...result.keys()]);
        if (orgErr) {
          console.warn(
            "[lineAvailability] org_week_thresholds select failed — fallback to common threshold",
            { message: orgErr.message },
          );
        } else {
          for (const r of (orgRows ?? []) as {
            week_id: string;
            check_threshold: number;
          }[]) {
            const s = result.get(r.week_id);
            if (s && r.check_threshold >= 0) s.checkThreshold = r.check_threshold;
          }
        }
      }
    }

    if (isoByWeekId.size > 0) {
      const years = [...new Set([...isoByWeekId.values()].map((v) => v.year))];
      type PointsRow = {
        year: number;
        week_number: number;
        points: number;
        checks_migrated?: boolean | null;
      };
      let pointRows: PointsRow[] | null = null;
      {
        const { data, error } = await supabaseAdmin
          .from("user_weekly_points")
          .select("year,week_number,points,checks_migrated")
          .eq("user_id", userId)
          .in("year", years);
        if (!error) {
          pointRows = (data ?? []) as PointsRow[];
        } else {
          // checks_migrated 컬럼 미적용 DB 방어: 컬럼 없이 재조회 — 전 행 "미이관" 취급
          // (게이트 미강제 = 기존 결과 보존, fail-safe).
          console.warn(
            "[lineAvailability] user_weekly_points.checks_migrated select failed — fallback (gate not enforced)",
            { message: error.message },
          );
          const { data: fallback, error: fallbackErr } = await supabaseAdmin
            .from("user_weekly_points")
            .select("year,week_number,points")
            .eq("user_id", userId)
            .in("year", years);
          if (fallbackErr) {
            console.warn("[lineAvailability] user_weekly_points fetch failed", {
              message: fallbackErr.message,
            });
          } else {
            pointRows = (fallback ?? []) as PointsRow[];
          }
        }
      }
      if (pointRows) {
        const rowByIso = new Map<string, PointsRow>();
        for (const p of pointRows) {
          rowByIso.set(`${p.year}-${p.week_number}`, p);
        }
        // 행 단위 이관 플래그(checks_migrated) 직독 — 행 부재/false = 미이관(보존).
        for (const [weekId, iso] of isoByWeekId) {
          const s = result.get(weekId);
          if (!s) continue;
          const row = rowByIso.get(`${iso.year}-${iso.week}`);
          s.checkCount = row?.points ?? 0;
          s.checkDataMigrated = row?.checks_migrated === true;
        }
      }
    }
  }

  return result;
}

// 레거시 통합 라인 상태 → 주차 verdict (단일 슬롯 환원).
//   강화(슬롯 enhancementStatus): 개설 + 본인 타깃 + (평점 ≥4 또는 미평가) → success /
//     평점 ≤3 → fail / 개설 + 미배정 → fail / 미개설 → not_applicable (기존 status 유지 — 실사용자 보존)
//   주차 성공(verdict.status) — 2026-06-05 정책 정정으로 강화 성공과 분리:
//     강화 success 라도 그 주차 check(user_weekly_points.points) < 기준값
//     (weeks.check_threshold ?? 30) 이면 verdict=fail (주차 실패).
//     슬롯 enhancementStatus 는 success 그대로 → "강화 성공 + 주차 실패" 표시 분리.
//     advantage/penalty 는 게이트에 사용하지 않는다.
export function reduceLegacyUnifiedVerdict(
  state: LegacyUnifiedWeekState | undefined,
): ExperienceGrowthVerdict {
  if (!state || !state.opened) {
    return reduceExperienceRequiredSlotVerdict([
      {
        slotOrder: 1,
        category: "derivation",
        enhancementStatus: "not_applicable" as Cluster4EnhancementStatus,
      },
    ]);
  }
  const enhancementStatus = computeCluster4Enhancement({
    hasTarget: state.hasTarget,
    deadlinePassed: state.deadlinePassed,
    hasSubmission: false, // enhancementStatus 산정에 미사용 (정책 유지)
    isCareer: false,
    expectedWhenMissing: true, // 개설됨 — 미배정이면 fail
    experienceRatingVerdict:
      state.hasTarget && state.rating != null
        ? state.rating <= EXPERIENCE_RATING_FAIL_THRESHOLD
          ? "fail"
          : "pass"
        : undefined,
  }).enhancementStatus;
  const verdict = reduceExperienceRequiredSlotVerdict([
    { slotOrder: 1, category: "derivation", enhancementStatus },
  ]);

  // ── check 게이트 (강화 success = 조건 A 충족 시에만 평가) ──
  //   pending(마감 전)·fail(평점/미배정)은 게이트 무관 — 기존 상태 유지.
  //   enforced=false (그 행의 checks_migrated 가 아니거나 행 부재 = check 미이관) 면
  //   강등하지 않고 기존 결과를 보존한다. 이관 행(true) 은 별도 작업 없이 자동 강등 적용.
  if (enhancementStatus === "success") {
    const gate: WeekCheckGate = {
      required: state.checkThreshold,
      earned: state.checkCount,
      passed: state.checkCount >= state.checkThreshold,
      enforced: state.checkDataMigrated,
    };
    return {
      ...verdict,
      // 조건 B 미달 + 강제 적용 → 주차 실패. failedSlotOrders 는 비움 — 슬롯(강화)은 실패가 아니다.
      status: gate.passed || !gate.enforced ? verdict.status : "fail",
      checkGate: gate,
    };
  }
  return verdict;
}

// 주차별 필수 슬롯(1/2/3) verdict. weekId(weeks.id) → verdict.
// cluster4_lines(experience) + cluster4_experience_line_masters.slot_order + targets + 마감 으로
// computeCluster4Enhancement 와 동일 기준으로 슬롯 상태를 산정한다. 추가 컬럼/제출 구조 변경 없음.
// 조회 실패 시 안전 폴백: 모든 슬롯 not_applicable (= 실패로 보지 않음).
// 레거시(허브 도입 전, start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) 주차는 3슬롯 규칙이
//   아니라 통합 라인 1개 기준(reduceLegacyUnifiedVerdict)으로 판정한다 — 내부에서 weeks.start_date
//   로 자동 분리하므로 호출부 변경 불요.
// opts.alwaysOpenWeekIds (2026-06-04 적용 시점 분리):
//   이 집합에 속한 (비레거시) 주차는 "필수 슬롯 항상-개설" 신정책 적용 — 슬롯 라인 행이 없어도
//   expectedWhenMissing=true → 본인 타깃 없으면 fail. 집합 밖 주차는 기존 기준(그 주차에
//   슬롯 라인이 실제 개설됐을 때만 fail) 유지. 호출부가 effectiveFrom(
//   CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM 이후 주차)·공표 여부로 집합을 구성한다.
export async function fetchExperienceRequiredSlotStatusByWeek(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
  opts: {
    alwaysOpenWeekIds?: ReadonlySet<string>;
    // 레거시 주차의 통합 라인 상태를 호출부가 이미 갖고 있으면 재조회를 생략한다.
    legacyUnifiedStates?: Map<string, LegacyUnifiedWeekState>;
    // 조직별 check 기준값 해석용 (org_week_thresholds) — fetchLegacyUnifiedExperienceByWeek
    // 로 passthrough. undefined = 내부 조회 / null = 공통 폴백 확정.
    organizationSlug?: OrganizationSlug | null;
    // 레거시 경계 오버라이드(테스트 시즌 시뮬레이션). 기본=CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM.
    //   과거 날짜를 주면 전 주차가 비레거시(여름)로 판정 → 5슬롯 verdict 로 계산.
    effectiveFrom?: string;
  } = {},
): Promise<Map<string, ExperienceGrowthVerdict>> {
  const alwaysOpenWeekIds = opts.alwaysOpenWeekIds ?? new Set<string>();
  const effectiveFrom = opts.effectiveFrom ?? CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  const result = new Map<string, ExperienceGrowthVerdict>();
  if (weekIds.length === 0) return result;

  const allNotApplicable = (): ExperienceGrowthVerdict =>
    reduceExperienceRequiredSlotVerdict(
      REQUIRED_SLOTS.map((s) => ({
        slotOrder: s.slotOrder,
        category: s.category,
        enhancementStatus: "not_applicable" as Cluster4EnhancementStatus,
      })),
    );

  // 0. 레거시(허브 도입 전) 주차 분리 — weeks.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM.
  //    레거시 주차는 통합 라인 단일 verdict, 그 외 주차는 기존 3슬롯 로직.
  //    weeks 조회 실패 시 전부 비레거시 취급(기존 로직 — 보수적).
  const legacyWeekIdSet = new Set<string>();
  {
    const { data: weekRows, error: weeksErr } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date")
      .in("id", weekIds);
    if (!weeksErr) {
      for (const w of (weekRows ?? []) as { id: string; start_date: string | null }[]) {
        if (w.start_date && isLegacyUnifiedWeekStart(w.start_date, effectiveFrom)) {
          legacyWeekIdSet.add(w.id);
        }
      }
    }
  }
  if (legacyWeekIdSet.size > 0) {
    const states =
      opts.legacyUnifiedStates ??
      (await fetchLegacyUnifiedExperienceByWeek(userId, [...legacyWeekIdSet], now, {
        organizationSlug: opts.organizationSlug,
      }));
    for (const w of legacyWeekIdSet) {
      result.set(w, reduceLegacyUnifiedVerdict(states.get(w)));
    }
  }
  const currentWeekIds = weekIds.filter((w) => !legacyWeekIdSet.has(w));
  if (currentWeekIds.length === 0) return result;

  // 1. active experience 라인 + 마감 + 마스터 id
  const { data: lineRows, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at,experience_line_master_id")
    .eq("part_type", "experience")
    .eq("is_active", true);

  // 조회 실패(에러)만 안전 폴백 — "행이 없음"은 폴백이 아니라 정책상 fail 로 계산된다.
  if (lineErr) {
    for (const w of currentWeekIds) result.set(w, allNotApplicable());
    return result;
  }

  const lines = (lineRows ?? []) as {
    id: string;
    submission_closes_at: string | null;
    experience_line_master_id: string | null;
  }[];

  // 2. 마스터 → slot_order
  const masterIds = [
    ...new Set(
      lines
        .map((l) => l.experience_line_master_id)
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  // (2E-4) registrations-first slot 룩업 (미커버 id 는 헬퍼 내부 마스터 fallback) — 결과 등가.
  const slotByMaster = await getExperienceSlotsByMasterIdsRegFirst(masterIds);

  // 3. line_id → 필수 슬롯(1/2/3) + 마감. 확장(4)/관리(5)/미분류 라인은 버린다.
  const lineSlot = new Map<
    string,
    { slotOrder: 1 | 2 | 3; closesAt: string | null }
  >();
  for (const l of lines) {
    const slot = l.experience_line_master_id
      ? slotByMaster.get(l.experience_line_master_id)
      : undefined;
    if (slot === 1 || slot === 2 || slot === 3) {
      lineSlot.set(l.id, { slotOrder: slot, closesAt: l.submission_closes_at });
    }
  }

  // 레거시 통합 마스터 라인은 3슬롯 로직에서 제외한다 (slot 1 마스터지만 레거시 전용 —
  // 비레거시 주차에는 타깃이 없어 실질 영향은 없으나 이중 방어).
  const unifiedMasterId = await fetchLegacyUnifiedMasterId();
  if (unifiedMasterId) {
    for (const l of lines) {
      if (l.experience_line_master_id === unifiedMasterId) lineSlot.delete(l.id);
    }
  }

  // 필수 슬롯 라인이 하나도 없으면: alwaysOpen 주차는 아래 루프에서 fail 로 계산해야 하므로
  // 신정책 주차가 하나도 없을 때만 not_applicable 단락한다.
  if (lineSlot.size === 0 && alwaysOpenWeekIds.size === 0) {
    for (const w of currentWeekIds) result.set(w, allNotApplicable());
    return result;
  }

  // 4. 해당 라인들의 주차별 타깃 (user 본인 배정 + "개설됨" 신호용 전체).
  //    ⚠ 전수 페이지네이션(안정 정렬 id asc) — PostgREST 기본 1000행 cap 절단 방지.
  //    절단되면 본인 타깃이 무작위로 누락돼 "항상-개설 + 타깃 없음 = fail" 오판이 비결정적으로
  //    발생한다(2026-06-04 실측: 17주차 보유자 매칭 1,338행 > cap → sync 무작위 flip).
  //    카드 라인 수집 경로(fetchAllLineTargetsByWeek)와 동일한 전수 수집 패턴 — 판정 정책/수식 무변경.
  let targets: {
    week_id: string;
    line_id: string;
    target_mode: string;
    target_user_id: string | null;
  }[] = [];
  if (lineSlot.size > 0) {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data: targetRows, error: targetErr } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("week_id,line_id,target_mode,target_user_id,id")
        .in("line_id", [...lineSlot.keys()])
        .in("week_id", currentWeekIds)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1);
      if (targetErr) {
        // 기존 동작 보존: 조회 에러는 무시하고 수집분으로 계속(원본도 에러를 무시했음).
        console.warn("[lineAvailability] required-slot targets page fetch failed", {
          from,
          message: targetErr.message,
        });
        break;
      }
      const page = (targetRows ?? []) as (typeof targets[number] & { id: string })[];
      targets = targets.concat(page);
      if (page.length < pageSize) break;
      from += pageSize;
    }
  }

  // week → slot → { 사용자 배정 라인 마감들, 그 주차에 (누구든) 개설 여부 }
  type SlotAgg = { userClosesAt: (string | null)[]; opened: boolean };
  const byWeek = new Map<string, Map<1 | 2 | 3, SlotAgg>>();
  const ensure = (week: string, slot: 1 | 2 | 3): SlotAgg => {
    let m = byWeek.get(week);
    if (!m) {
      m = new Map();
      byWeek.set(week, m);
    }
    let a = m.get(slot);
    if (!a) {
      a = { userClosesAt: [], opened: false };
      m.set(slot, a);
    }
    return a;
  };

  for (const t of targets) {
    const meta = lineSlot.get(t.line_id);
    if (!meta) continue;
    const agg = ensure(t.week_id, meta.slotOrder);
    agg.opened = true; // 그 주차에 해당 슬롯 라인이 (누구든) 개설됨 → expectedWhenMissing 신호
    if (t.target_mode === "user" && t.target_user_id === userId) {
      agg.userClosesAt.push(meta.closesAt);
    }
  }

  // 5. 주차별 슬롯 1/2/3 강화상태 (computeCluster4Enhancement 재사용 → 정책 동일성 보장)
  //   적용 시점 분리(2026-06-04): alwaysOpenWeekIds 주차만 "필수 슬롯 항상-개설(라인 행 없어도
  //   fail)" 신정책. 그 외 주차는 기존 기준(실제 개설됐을 때만 fail) — 과거 실사용자의
  //   누적 인정 주차/시즌 성장률이 소급 붕괴하지 않도록 호출부가 effectiveFrom/테스트 여부로
  //   집합을 제한한다.
  for (const w of currentWeekIds) {
    const wk = byWeek.get(w);
    const alwaysOpen = alwaysOpenWeekIds.has(w);
    const slots: ExperienceRequiredSlotStatus[] = REQUIRED_SLOTS.map((s) => {
      const agg = wk?.get(s.slotOrder);
      const hasTarget = Boolean(agg && agg.userClosesAt.length > 0);
      const deadlinePassed = hasTarget
        ? agg!.userClosesAt.some(
            (c) => Boolean(c) && new Date(c as string).getTime() < now,
          )
        : false;
      const expectedWhenMissing = alwaysOpen || Boolean(agg?.opened);
      const enhancementStatus = computeCluster4Enhancement({
        hasTarget,
        deadlinePassed,
        hasSubmission: false, // enhancementStatus 산정에 미사용 (정책 유지)
        isCareer: false,
        expectedWhenMissing,
      }).enhancementStatus;
      return {
        slotOrder: s.slotOrder,
        category: s.category,
        enhancementStatus,
      };
    });
    result.set(w, reduceExperienceRequiredSlotVerdict(slots));
  }

  return result;
}
