import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

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
): WeekLineAvailability {
  const info = weekId ? (infoMap.get(weekId) ?? 0) : 0;
  const rawCareer = weekId ? (careerMap.get(weekId) ?? 0) : 0;
  return {
    info,
    ability: ABILITY_AVAILABLE,
    experience: getExperienceAvailable(organization),
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
