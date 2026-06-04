import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  computeCluster4Enhancement,
  EXPERIENCE_RATING_FAIL_THRESHOLD,
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
// v11 슬롯 정책 적용 시점 분리 (2026-06-04 확정):
//   - 실사용자: start_date >= 이 날짜인 주차(= 정책 채택일 2026-06-04 이후 시작하는 첫 주차
//     2026-06-08 = 2026-spring W15)부터 "필수 슬롯 항상-개설(fail)" 신정책을 라인 칸·강화율·
//     주차 verdict·user_week_statuses sync 전부에 적용한다.
//   - 실사용자의 이 날짜 이전 주차: 신정책 미적용(placeholder 는 해당 없음) — 과거
//     user_week_statuses success 소급 강등 금지, 누적 인정 주차·시즌 성장률 보존.
//   - 테스트 사용자(isTestDisplayName, display_name ILIKE '%T%'): 시점 제한 없음 — 과거
//     주차에도 전면 적용(대량 fail 전환 허용).
//   - 공통: 진행 중(running)·집계 중(tallying = 미공표) 주차에는 placeholder fail 선반영 금지 —
//     마감/판정 완료(공표) 주차에만 fail. 그 전에는 해당 없음(void)으로 둔다.
// ─────────────────────────────────────────────────────────────────────
export const CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM = "2026-06-08";

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
  const slotByMasterId = new Map<string, number>();
  const masterIds = [...new Set(masterIdByLineId.values())];
  if (masterIds.length > 0) {
    const { data: masters } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("id,experience_slot_order")
      .in("id", masterIds);
    for (const m of (masters ?? []) as {
      id: string;
      experience_slot_order: number | null;
    }[]) {
      if (m.experience_slot_order != null)
        slotByMasterId.set(m.id, m.experience_slot_order);
    }
  }

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

export type ExperienceGrowthVerdict = {
  status: ExperienceGrowthVerdictStatus;
  requiredSlots: ExperienceRequiredSlotStatus[];
  failedSlotOrders: number[];
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

// 주차별 필수 슬롯(1/2/3) verdict. weekId(weeks.id) → verdict.
// cluster4_lines(experience) + cluster4_experience_line_masters.slot_order + targets + 마감 으로
// computeCluster4Enhancement 와 동일 기준으로 슬롯 상태를 산정한다. 추가 컬럼/제출 구조 변경 없음.
// 조회 실패 시 안전 폴백: 모든 슬롯 not_applicable (= 실패로 보지 않음).
// opts.alwaysOpenWeekIds (2026-06-04 적용 시점 분리):
//   이 집합에 속한 주차는 "필수 슬롯 항상-개설" 신정책 적용 — 슬롯 라인 행이 없어도
//   expectedWhenMissing=true → 본인 타깃 없으면 fail. 집합 밖 주차는 기존 기준(그 주차에
//   슬롯 라인이 실제 개설됐을 때만 fail) 유지. 호출부가 effectiveFrom(실사용자
//   CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM 이후 주차)·테스트 사용자(전 주차)·공표 여부로 집합을
//   구성한다 — 과거 실사용자의 누적 인정/시즌 성장률 보존이 목적.
export async function fetchExperienceRequiredSlotStatusByWeek(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
  opts: { alwaysOpenWeekIds?: ReadonlySet<string> } = {},
): Promise<Map<string, ExperienceGrowthVerdict>> {
  const alwaysOpenWeekIds = opts.alwaysOpenWeekIds ?? new Set<string>();
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

  // 1. active experience 라인 + 마감 + 마스터 id
  const { data: lineRows, error: lineErr } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at,experience_line_master_id")
    .eq("part_type", "experience")
    .eq("is_active", true);

  // 조회 실패(에러)만 안전 폴백 — "행이 없음"은 폴백이 아니라 정책상 fail 로 계산된다.
  if (lineErr) {
    for (const w of weekIds) result.set(w, allNotApplicable());
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
  const slotByMaster = new Map<string, number>();
  if (masterIds.length > 0) {
    const { data: masters } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("id,experience_slot_order")
      .in("id", masterIds);
    for (const m of (masters ?? []) as {
      id: string;
      experience_slot_order: number | null;
    }[]) {
      if (m.experience_slot_order != null)
        slotByMaster.set(m.id, m.experience_slot_order);
    }
  }

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

  // 필수 슬롯 라인이 하나도 없으면: alwaysOpen 주차는 아래 루프에서 fail 로 계산해야 하므로
  // 신정책 주차가 하나도 없을 때만 not_applicable 단락한다.
  if (lineSlot.size === 0 && alwaysOpenWeekIds.size === 0) {
    for (const w of weekIds) result.set(w, allNotApplicable());
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
        .in("week_id", weekIds)
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
  for (const w of weekIds) {
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
