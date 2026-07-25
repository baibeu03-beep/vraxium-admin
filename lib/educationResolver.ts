import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type EducationAuthorityRow = {
  id?: string | number;
  user_id: string;
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number | null;
  is_primary: boolean | null;
  updated_at: string | null;
  [key: string]: unknown;
};

const BASE_SELECT =
  "id,user_id,school_name,major_name_1,sort_order,is_primary,updated_at";

export function selectRepresentativeEducation<
  T extends {
    is_primary?: boolean | null;
    sort_order?: number | null;
    updated_at?: string | null;
  },
>(rows: readonly T[]): T | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const primaryDelta =
      Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
    if (primaryDelta !== 0) return primaryDelta;
    const sortDelta =
      (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
      (b.sort_order ?? Number.MAX_SAFE_INTEGER);
    if (sortDelta !== 0) return sortDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

export async function loadEducationRowsByUserIds(
  userIds: readonly string[],
  select = BASE_SELECT,
): Promise<Map<string, EducationAuthorityRow[]>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, EducationAuthorityRow[]>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabaseAdmin
      .from("user_educations")
      .select(select)
      .in("user_id", ids.slice(i, i + 300));
    if (error) throw new Error(`user_educations load failed: ${error.message}`);
    for (const row of (data ?? []) as unknown as EducationAuthorityRow[]) {
      const rows = result.get(row.user_id) ?? [];
      rows.push(row);
      result.set(row.user_id, rows);
    }
  }
  return result;
}

export async function resolveRepresentativeEducations(
  userIds: readonly string[],
): Promise<
  Map<
    string,
    {
      row: EducationAuthorityRow | null;
      schoolName: string | null;
      majorName: string | null;
    }
  >
> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const [educationRows, profiles] = await Promise.all([
    loadEducationRowsByUserIds(ids),
    (async () => {
      const result: Array<{
        user_id: string;
        school_name: string | null;
        department_name: string | null;
      }> = [];
      for (let i = 0; i < ids.length; i += 300) {
        const { data, error } = await supabaseAdmin
          .from("user_profiles")
          .select("user_id,school_name,department_name")
          .in("user_id", ids.slice(i, i + 300));
        if (error) {
          throw new Error(
            `user_profiles education fallback failed: ${error.message}`,
          );
        }
        result.push(...((data ?? []) as typeof result));
      }
      return new Map(result.map((row) => [row.user_id, row]));
    })(),
  ]);
  const resolved = new Map<
    string,
    {
      row: EducationAuthorityRow | null;
      schoolName: string | null;
      majorName: string | null;
    }
  >();
  for (const userId of ids) {
    const row = selectRepresentativeEducation(
      educationRows.get(userId) ?? [],
    );
    const profile = profiles.get(userId);
    resolved.set(userId, {
      row,
      schoolName:
        row?.school_name?.trim() || profile?.school_name?.trim() || null,
      majorName:
        row?.major_name_1?.trim() ||
        profile?.department_name?.trim() ||
        null,
    });
  }
  return resolved;
}
