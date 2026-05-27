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

export function ceilGrowthRate(completed: number, available: number): number {
  return available === 0 ? 0 : Math.ceil((completed / available) * 100);
}
