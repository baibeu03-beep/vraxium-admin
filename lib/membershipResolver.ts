export type SelectableMembership = {
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current?: boolean | null;
  updated_at?: string | null;
};

export function nonEmptyText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function membershipRank(row: SelectableMembership): number {
  const current = row.is_current === true;
  const hasTeam = nonEmptyText(row.team_name) !== null;
  if (current && hasTeam) return 0;
  if (hasTeam) return 1;
  if (current) return 2;
  return 3;
}

/**
 * 모든 현재값 fallback이 공유하는 membership 선택 규칙.
 * 팀/파트/클래스는 반드시 이 함수가 고른 같은 행에서 읽는다.
 */
export function selectMembershipRow<T extends SelectableMembership>(
  rows: readonly T[],
): T | null {
  return [...rows].sort((a, b) => {
    const rank = membershipRank(a) - membershipRank(b);
    if (rank !== 0) return rank;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0] ?? null;
}
