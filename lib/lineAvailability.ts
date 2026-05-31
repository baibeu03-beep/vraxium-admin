import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import type { Cluster4EnhancementStatus } from "@/shared/cluster4.contracts";

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

export const CAREER_DISPLAY_CAP = 5;

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

export function buildWeekAvailability(
  weekId: string | null,
  infoMap: Map<string, number>,
  careerMap: Map<string, number>,
  organization: OrganizationSlug | null,
  experienceMap?: Map<string, number>,
  competencyMap?: Map<string, number>,
): WeekLineAvailability {
  const info = weekId ? (infoMap.get(weekId) ?? 0) : 0;
  const rawCareer = weekId ? (careerMap.get(weekId) ?? 0) : 0;
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

// 그 주차에 info 라인이 (누구든) 개설됐는지 — fail vs not_applicable 구분 신호.
// 배정 없음 + 개설됨 → fail / 미개설 → not_applicable.
export async function fetchWeeksWithAnyInfoLine(
  weekIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
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
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  for (const t of (targets ?? []) as { week_id: string }[]) {
    result.add(t.week_id);
  }
  return result;
}

// 그 주차에 experience 라인이 (누구든) 개설됐는지 — fail vs not_applicable 구분 신호.
// 배정 없음 + 개설됨 → fail / 미개설 → not_applicable.
// fetchWeeksWithAnyInfoLine 와 동일 방식(part_type 만 'experience').
export async function fetchWeeksWithAnyExperienceLine(
  weekIds: string[],
): Promise<Set<string>> {
  const result = new Set<string>();
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
    .in("line_id", lineIds)
    .in("week_id", weekIds);

  for (const t of (targets ?? []) as { week_id: string }[]) {
    result.add(t.week_id);
  }
  return result;
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
export async function fetchExperienceRequiredSlotStatusByWeek(
  userId: string,
  weekIds: string[],
  now: number = Date.now(),
): Promise<Map<string, ExperienceGrowthVerdict>> {
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
  const { data: lineRows } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at,experience_line_master_id")
    .eq("part_type", "experience")
    .eq("is_active", true);

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

  // 필수 슬롯 라인이 하나도 없으면 모든 주차 not_applicable.
  if (lineSlot.size === 0) {
    for (const w of weekIds) result.set(w, allNotApplicable());
    return result;
  }

  // 4. 해당 라인들의 주차별 타깃 (user 본인 배정 + "개설됨" 신호용 전체).
  const { data: targetRows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id,line_id,target_mode,target_user_id")
    .in("line_id", [...lineSlot.keys()])
    .in("week_id", weekIds);

  const targets = (targetRows ?? []) as {
    week_id: string;
    line_id: string;
    target_mode: string;
    target_user_id: string | null;
  }[];

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
  for (const w of weekIds) {
    const wk = byWeek.get(w);
    const slots: ExperienceRequiredSlotStatus[] = REQUIRED_SLOTS.map((s) => {
      const agg = wk?.get(s.slotOrder);
      const hasTarget = Boolean(agg && agg.userClosesAt.length > 0);
      const deadlinePassed = hasTarget
        ? agg!.userClosesAt.some(
            (c) => Boolean(c) && new Date(c as string).getTime() < now,
          )
        : false;
      const expectedWhenMissing = Boolean(agg?.opened);
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
