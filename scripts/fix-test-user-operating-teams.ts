import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const SEED_BATCH_ID = "2026-05-26_seed_90users_v2";
const LEGACY_BATCH_ID = "2026-05-22_seed_30users_v1";

const allowedTeams = {
  encre: ["갤러리", "비주얼", "팬마케팅", "프로듀싱", "A&R"],
  oranke: ["스타일", "엔터테인먼트", "커머스", "콘텐츠", "F&B", "신입"],
  phalanx: ["브랜딩", "서비스", "IT"],
} as const;

type OrganizationSlug = keyof typeof allowedTeams;

type Marker = {
  user_id: string;
  legacy_user_id: number | null;
  seed_batch_id: string;
  user_type: string | null;
};

type Profile = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  organization_slug: string | null;
};

type Membership = {
  id: string;
  user_id: string;
  team_name: string | null;
  is_current: boolean | null;
};

type GrowthStats = {
  user_id: string;
  cumulative_weeks: number | null;
  approved_weeks: number | null;
};

type TargetUser = {
  marker: Marker;
  profile: Profile;
  membership: Membership;
  growth: GrowthStats | null;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function isKnownOrg(slug: string | null): slug is OrganizationSlug {
  return slug === "encre" || slug === "oranke" || slug === "phalanx";
}

function weeksAreZero(growth: GrowthStats | null) {
  return (growth?.cumulative_weeks ?? 0) === 0 && (growth?.approved_weeks ?? 0) === 0;
}

function isValid(user: TargetUser) {
  const org = user.profile.organization_slug;
  const team = user.membership.team_name;

  if (!isKnownOrg(org) || !team) return false;
  if (!(allowedTeams[org] as readonly string[]).includes(team)) return false;
  return team !== "신입" || (org === "oranke" && weeksAreZero(user.growth));
}

async function selectAll<T>(table: string, select: string, filter: (query: any) => any): Promise<T[]> {
  const pageSize = 1000;
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const query = filter(supabase.from(table).select(select)).range(from, from + pageSize - 1);
    const { data, error } = await query;
    if (error) throw new Error(`${table} select failed: ${error.message}`);

    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

async function loadBatch(seedBatchId: string): Promise<TargetUser[]> {
  const markers = await selectAll<Marker>(
    "test_user_markers",
    "user_id,legacy_user_id,seed_batch_id,user_type",
    (q) => q.eq("seed_batch_id", seedBatchId),
  );

  const userIds = markers.map((m) => m.user_id);
  if (userIds.length === 0) return [];

  const [profiles, memberships, growthStats] = await Promise.all([
    selectAll<Profile>(
      "user_profiles",
      "user_id,display_name,auth_email,organization_slug",
      (q) => q.in("user_id", userIds),
    ),
    selectAll<Membership>(
      "user_memberships",
      "id,user_id,team_name,is_current",
      (q) => q.in("user_id", userIds),
    ),
    selectAll<GrowthStats>(
      "user_growth_stats",
      "user_id,cumulative_weeks,approved_weeks",
      (q) => q.in("user_id", userIds),
    ),
  ]);

  const profileByUserId = new Map(profiles.map((p) => [p.user_id, p]));
  const growthByUserId = new Map(growthStats.map((g) => [g.user_id, g]));
  const currentMembershipByUserId = new Map(
    memberships
      .filter((m) => m.is_current !== false)
      .map((m) => [m.user_id, m]),
  );

  return markers.flatMap((marker) => {
    const profile = profileByUserId.get(marker.user_id);
    const membership = currentMembershipByUserId.get(marker.user_id);

    if (!profile || !membership) return [];
    return [{
      marker,
      profile,
      membership,
      growth: growthByUserId.get(marker.user_id) ?? null,
    }];
  });
}

function summarizeInvalid(users: TargetUser[]) {
  const invalid = users.filter((user) => !isValid(user));
  const byTeam = new Map<string, number>();

  for (const user of invalid) {
    const key = `${user.profile.organization_slug ?? "unknown"} / ${user.membership.team_name ?? "null"}`;
    byTeam.set(key, (byTeam.get(key) ?? 0) + 1);
  }

  return {
    invalid,
    byTeam: [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

function summarizeFinal(users: TargetUser[]) {
  const organizationCounts = new Map<string, number>();
  const teamCounts = new Map<string, number>();
  let newbieCount = 0;
  let newbieApprovedWeeksGtZero = 0;
  let newbieCumulativeWeeksGtZero = 0;

  for (const user of users) {
    const org = user.profile.organization_slug ?? "unknown";
    const team = user.membership.team_name ?? "null";
    const teamKey = `${org} / ${team}`;
    const approvedWeeks = user.growth?.approved_weeks ?? 0;
    const cumulativeWeeks = user.growth?.cumulative_weeks ?? 0;

    organizationCounts.set(org, (organizationCounts.get(org) ?? 0) + 1);
    teamCounts.set(teamKey, (teamCounts.get(teamKey) ?? 0) + 1);

    if (team === "신입") {
      newbieCount++;
      if (approvedWeeks > 0) newbieApprovedWeeksGtZero++;
      if (cumulativeWeeks > 0) newbieCumulativeWeeksGtZero++;
    }
  }

  return {
    organization_counts: [...organizationCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    team_counts: [...teamCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
    newbie_count: newbieCount,
    newbie_approved_weeks_gt_zero_count: newbieApprovedWeeksGtZero,
    newbie_cumulative_weeks_gt_zero_count: newbieCumulativeWeeksGtZero,
  };
}

function compareByLegacyUserId(a: TargetUser, b: TargetUser) {
  const legacyA = a.marker.legacy_user_id ?? Number.MAX_SAFE_INTEGER;
  const legacyB = b.marker.legacy_user_id ?? Number.MAX_SAFE_INTEGER;
  return legacyA - legacyB || a.marker.user_id.localeCompare(b.marker.user_id);
}

function buildRoundRobinAssignments(users: TargetUser[]) {
  const byOrg = new Map<OrganizationSlug, TargetUser[]>();

  for (const user of users) {
    if (!isKnownOrg(user.profile.organization_slug)) continue;
    const org = user.profile.organization_slug;
    const orgUsers = byOrg.get(org) ?? [];
    orgUsers.push(user);
    byOrg.set(org, orgUsers);
  }

  const assignments: Array<TargetUser & { targetTeamName: string }> = [];

  for (const [org, orgUsers] of byOrg.entries()) {
    const orderedUsers = [...orgUsers].sort(compareByLegacyUserId);

    if (org !== "oranke") {
      const teams = allowedTeams[org];
      orderedUsers.forEach((user, index) => {
        assignments.push({ ...user, targetTeamName: teams[index % teams.length] });
      });
      continue;
    }

    const newbieTeam = "신입";
    const operatingTeams = allowedTeams.oranke.filter((team) => team !== newbieTeam);
    const targetNewbieCount = Math.floor(orderedUsers.length / allowedTeams.oranke.length);
    const zeroWeekUsers = orderedUsers.filter((user) => weeksAreZero(user.growth));
    const newbieUserIds = new Set(
      zeroWeekUsers
        .slice(0, targetNewbieCount)
        .map((user) => user.marker.user_id),
    );

    let operatingIndex = 0;
    for (const user of orderedUsers) {
      if (newbieUserIds.has(user.marker.user_id)) {
        assignments.push({ ...user, targetTeamName: newbieTeam });
        continue;
      }

      assignments.push({
        ...user,
        targetTeamName: operatingTeams[operatingIndex % operatingTeams.length],
      });
      operatingIndex++;
    }
  }

  return assignments;
}

async function main() {
  const targetUsers = await loadBatch(SEED_BATCH_ID);
  const legacyUsers = await loadBatch(LEGACY_BATCH_ID);

  const before = summarizeInvalid(targetUsers);
  const legacy = summarizeInvalid(legacyUsers);

  console.log(JSON.stringify({
    seed_batch_id: SEED_BATCH_ID,
    target_current_membership_users: targetUsers.length,
    invalid_before: before.invalid.length,
    invalid_before_by_org_team: before.byTeam,
    legacy_30_batch_report_only: {
      seed_batch_id: LEGACY_BATCH_ID,
      current_membership_users: legacyUsers.length,
      invalid_count: legacy.invalid.length,
      invalid_by_org_team: legacy.byTeam,
    },
  }, null, 2));

  const unknownOrgInvalid = before.invalid.filter((user) => !isKnownOrg(user.profile.organization_slug));
  if (unknownOrgInvalid.length > 0) {
    throw new Error(`Refusing to update ${unknownOrgInvalid.length} users with unknown organization_slug`);
  }

  const assignments = buildRoundRobinAssignments(targetUsers)
    .filter((assignment) => assignment.membership.team_name !== assignment.targetTeamName);

  for (const assignment of assignments) {
    const { error } = await supabase
      .from("user_memberships")
      .update({ team_name: assignment.targetTeamName })
      .eq("id", assignment.membership.id)
      .eq("user_id", assignment.marker.user_id);

    if (error) {
      throw new Error(`Failed to update ${assignment.marker.user_id}: ${error.message}`);
    }
  }

  const afterUsers = await loadBatch(SEED_BATCH_ID);
  const after = summarizeInvalid(afterUsers);
  const finalSummary = summarizeFinal(afterUsers);

  console.log(JSON.stringify({
    updated_memberships: assignments.length,
    assignments: assignments.map((user) => ({
      legacy_user_id: user.marker.legacy_user_id,
      user_id: user.marker.user_id,
      display_name: user.profile.display_name,
      organization_slug: user.profile.organization_slug,
      from_team_name: user.membership.team_name,
      to_team_name: user.targetTeamName,
      cumulative_weeks: user.growth?.cumulative_weeks ?? 0,
      approved_weeks: user.growth?.approved_weeks ?? 0,
    })),
    invalid_after: after.invalid.length,
    invalid_after_by_org_team: after.byTeam,
    ...finalSummary,
  }, null, 2));

  if (after.invalid.length !== 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
