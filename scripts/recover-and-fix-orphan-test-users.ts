import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const RECOVERED_SEED_BATCH_ID = "2026-05-22_seed_30users_v1";

const allowedTeams = {
  encre: ["갤러리", "비주얼", "팬마케팅", "프로듀싱", "A&R"],
  oranke: ["스타일", "엔터테인먼트", "커머스", "콘텐츠", "F&B", "신입"],
  phalanx: ["브랜딩", "서비스", "IT"],
} as const;

type OrganizationSlug = keyof typeof allowedTeams;

type Profile = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  organization_slug: string | null;
};

type Marker = {
  user_id: string;
  seed_batch_id: string | null;
  legacy_user_id: number | null;
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

type OrphanTestUser = {
  profile: Profile;
  membership: Membership;
  growth: GrowthStats | null;
  legacyUserId: number;
  userType: string;
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

function isValid(user: OrphanTestUser) {
  const org = user.profile.organization_slug;
  const team = user.membership.team_name;

  if (!isKnownOrg(org) || !team) return false;
  if (!(allowedTeams[org] as readonly string[]).includes(team)) return false;
  return team !== "신입" || (org === "oranke" && weeksAreZero(user.growth));
}

function legacyUserIdFromPhone(phone: string | null) {
  const match = phone?.match(/^010-9900-(\d{4})$/);
  if (!match) return null;
  return 900000 + Number(match[1]);
}

function userTypeFromGrowth(growth: GrowthStats | null) {
  const cumulativeWeeks = growth?.cumulative_weeks ?? 0;
  const approvedWeeks = growth?.approved_weeks ?? 0;

  if (cumulativeWeeks === 0 && approvedWeeks === 0) return "newbie";
  if (cumulativeWeeks >= 25 || approvedWeeks >= 20) return "high_activity";
  return "normal";
}

function isLikelySyntheticTestProfile(profile: Profile) {
  const signals = [
    profile.display_name?.includes("[TEST]") ?? false,
    profile.auth_email?.endsWith("@vraxium.test") ?? false,
    profile.contact_email?.endsWith("@vraxium.test") ?? false,
    /^010-9900-\d{4}$/.test(profile.contact_phone ?? ""),
  ];

  return signals.every(Boolean);
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

async function loadOrphanTestUsers() {
  const profiles = await selectAll<Profile>(
    "user_profiles",
    "user_id,display_name,auth_email,contact_email,contact_phone,organization_slug",
    (q) => q.ilike("display_name", "%[TEST]%"),
  );

  const userIds = profiles.map((profile) => profile.user_id);
  const [markers, memberships, growthStats] = userIds.length === 0
    ? [[], [], []] as [Marker[], Membership[], GrowthStats[]]
    : await Promise.all([
      selectAll<Marker>(
        "test_user_markers",
        "user_id,seed_batch_id,legacy_user_id",
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

  const markedUserIds = new Set(markers.map((marker) => marker.user_id));
  const membershipByUserId = new Map(
    memberships
      .filter((membership) => membership.is_current !== false)
      .map((membership) => [membership.user_id, membership]),
  );
  const growthByUserId = new Map(growthStats.map((growth) => [growth.user_id, growth]));

  return profiles
    .filter((profile) => !markedUserIds.has(profile.user_id))
    .map((profile) => {
      const membership = membershipByUserId.get(profile.user_id);
      const growth = growthByUserId.get(profile.user_id) ?? null;
      const legacyUserId = legacyUserIdFromPhone(profile.contact_phone);

      if (!membership || !legacyUserId) return null;
      return {
        profile,
        membership,
        growth,
        legacyUserId,
        userType: userTypeFromGrowth(growth),
      };
    })
    .filter((user): user is OrphanTestUser => user !== null)
    .sort((a, b) => a.legacyUserId - b.legacyUserId);
}

function buildRoundRobinAssignments(users: OrphanTestUser[]) {
  const byOrg = new Map<OrganizationSlug, OrphanTestUser[]>();

  for (const user of users) {
    if (!isKnownOrg(user.profile.organization_slug)) continue;
    const org = user.profile.organization_slug;
    const orgUsers = byOrg.get(org) ?? [];
    orgUsers.push(user);
    byOrg.set(org, orgUsers);
  }

  const assignments: Array<OrphanTestUser & { targetTeamName: string }> = [];

  for (const [org, orgUsers] of byOrg.entries()) {
    const orderedUsers = [...orgUsers].sort((a, b) => a.legacyUserId - b.legacyUserId);

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
        .map((user) => user.profile.user_id),
    );

    let operatingIndex = 0;
    for (const user of orderedUsers) {
      if (newbieUserIds.has(user.profile.user_id)) {
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

function summarize(users: OrphanTestUser[]) {
  const invalid = users.filter((user) => !isValid(user));
  const byTeam = new Map<string, number>();

  for (const user of users) {
    const key = `${user.profile.organization_slug ?? "unknown"} / ${user.membership.team_name ?? "null"}`;
    byTeam.set(key, (byTeam.get(key) ?? 0) + 1);
  }

  return {
    total: users.length,
    invalid_count: invalid.length,
    team_counts: [...byTeam.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

async function main() {
  const orphanUsers = await loadOrphanTestUsers();
  const unsafeUsers = orphanUsers.filter((user) => !isLikelySyntheticTestProfile(user.profile));
  const unknownOrgUsers = orphanUsers.filter((user) => !isKnownOrg(user.profile.organization_slug));

  console.log(JSON.stringify({
    orphan_test_like_users: orphanUsers.length,
    before: summarize(orphanUsers),
    unsafe_users: unsafeUsers.map((user) => ({
      user_id: user.profile.user_id,
      display_name: user.profile.display_name,
      auth_email: user.profile.auth_email,
      contact_email: user.profile.contact_email,
      contact_phone: user.profile.contact_phone,
    })),
    unknown_org_users: unknownOrgUsers.map((user) => ({
      user_id: user.profile.user_id,
      display_name: user.profile.display_name,
      organization_slug: user.profile.organization_slug,
    })),
  }, null, 2));

  if (unsafeUsers.length > 0) {
    throw new Error(`Refusing to modify ${unsafeUsers.length} users without full TEST signals`);
  }

  if (unknownOrgUsers.length > 0) {
    throw new Error(`Refusing to modify ${unknownOrgUsers.length} users with unknown organization_slug`);
  }

  for (const user of orphanUsers) {
    const { error } = await supabase
      .from("test_user_markers")
      .insert({
        user_id: user.profile.user_id,
        seed_batch_id: RECOVERED_SEED_BATCH_ID,
        legacy_user_id: user.legacyUserId,
        user_type: user.userType,
        note: `recovered orphan TEST marker; organization=${user.profile.organization_slug}; email=${user.profile.auth_email}`,
      });

    if (error) {
      throw new Error(`Marker insert failed for ${user.profile.user_id}: ${error.message}`);
    }
  }

  const assignments = buildRoundRobinAssignments(orphanUsers)
    .filter((assignment) => assignment.membership.team_name !== assignment.targetTeamName);

  for (const assignment of assignments) {
    const { error } = await supabase
      .from("user_memberships")
      .update({ team_name: assignment.targetTeamName })
      .eq("id", assignment.membership.id)
      .eq("user_id", assignment.profile.user_id);

    if (error) {
      throw new Error(`Membership update failed for ${assignment.profile.user_id}: ${error.message}`);
    }
  }

  const afterOrphans = await loadOrphanTestUsers();

  const recoveredUsers = await selectAll<Marker>(
    "test_user_markers",
    "user_id,seed_batch_id,legacy_user_id",
    (q) => q.eq("seed_batch_id", RECOVERED_SEED_BATCH_ID),
  );

  console.log(JSON.stringify({
    inserted_markers: orphanUsers.length,
    updated_memberships: assignments.length,
    assignments: assignments.map((assignment) => ({
      legacy_user_id: assignment.legacyUserId,
      user_id: assignment.profile.user_id,
      display_name: assignment.profile.display_name,
      organization_slug: assignment.profile.organization_slug,
      from_team_name: assignment.membership.team_name,
      to_team_name: assignment.targetTeamName,
      cumulative_weeks: assignment.growth?.cumulative_weeks ?? 0,
      approved_weeks: assignment.growth?.approved_weeks ?? 0,
    })),
    orphan_test_like_users_after: afterOrphans.length,
    recovered_batch_marker_count: recoveredUsers.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
