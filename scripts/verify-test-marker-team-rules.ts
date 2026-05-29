import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const allowedTeams = {
  encre: ["갤러리", "비주얼", "팬마케팅", "프로듀싱", "A&R"],
  oranke: ["스타일", "엔터테인먼트", "커머스", "콘텐츠", "F&B", "신입"],
  phalanx: ["브랜딩", "서비스", "IT"],
} as const;

type OrganizationSlug = keyof typeof allowedTeams;

type Marker = {
  user_id: string;
  seed_batch_id: string | null;
  legacy_user_id: number | null;
};

type Profile = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
  auth_email: string | null;
};

type Membership = {
  user_id: string;
  team_name: string | null;
  is_current: boolean | null;
};

type GrowthStats = {
  user_id: string;
  cumulative_weeks: number | null;
  approved_weeks: number | null;
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

async function main() {
  const markers = await selectAll<Marker>(
    "test_user_markers",
    "user_id,seed_batch_id,legacy_user_id",
    (q) => q,
  );

  const userIds = markers.map((marker) => marker.user_id);
  const [profiles, memberships, growthStats] = userIds.length === 0
    ? [[], [], []] as [Profile[], Membership[], GrowthStats[]]
    : await Promise.all([
      selectAll<Profile>(
        "user_profiles",
        "user_id,display_name,organization_slug,auth_email",
        (q) => q.in("user_id", userIds),
      ),
      selectAll<Membership>(
        "user_memberships",
        "user_id,team_name,is_current",
        (q) => q.in("user_id", userIds),
      ),
      selectAll<GrowthStats>(
        "user_growth_stats",
        "user_id,cumulative_weeks,approved_weeks",
        (q) => q.in("user_id", userIds),
      ),
    ]);

  const profileByUserId = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const growthByUserId = new Map(growthStats.map((growth) => [growth.user_id, growth]));
  const currentMemberships = memberships.filter((membership) => membership.is_current !== false);

  const invalid = [];
  const forbiddenMediaPlanning = [];
  const teamCounts = new Map<string, number>();
  let newbieCount = 0;
  let newbieApprovedWeeksGtZero = 0;
  let newbieCumulativeWeeksGtZero = 0;

  for (const membership of currentMemberships) {
    const profile = profileByUserId.get(membership.user_id);
    const growth = growthByUserId.get(membership.user_id);
    const org = profile?.organization_slug ?? null;
    const team = membership.team_name;
    const approvedWeeks = growth?.approved_weeks ?? 0;
    const cumulativeWeeks = growth?.cumulative_weeks ?? 0;
    const key = `${org ?? "unknown"} / ${team ?? "null"}`;

    teamCounts.set(key, (teamCounts.get(key) ?? 0) + 1);

    if (team === "신입") {
      newbieCount++;
      if (approvedWeeks > 0) newbieApprovedWeeksGtZero++;
      if (cumulativeWeeks > 0) newbieCumulativeWeeksGtZero++;
    }

    const teamAllowed = isKnownOrg(org) && !!team && (allowedTeams[org] as readonly string[]).includes(team);
    const newbieInvalid = team === "신입" && (org !== "oranke" || approvedWeeks > 0 || cumulativeWeeks > 0);

    if (!teamAllowed || newbieInvalid) {
      invalid.push({
        user_id: membership.user_id,
        display_name: profile?.display_name ?? null,
        organization_slug: org,
        team_name: team,
        cumulative_weeks: cumulativeWeeks,
        approved_weeks: approvedWeeks,
      });
    }

    if (team === "미디어" || team === "기획") {
      forbiddenMediaPlanning.push({
        user_id: membership.user_id,
        display_name: profile?.display_name ?? null,
        organization_slug: org,
        team_name: team,
      });
    }
  }

  console.log(JSON.stringify({
    marker_users: markers.length,
    current_memberships: currentMemberships.length,
    invalid_count: invalid.length,
    invalid,
    forbidden_media_planning_count: forbiddenMediaPlanning.length,
    forbidden_media_planning: forbiddenMediaPlanning,
    newbie_count: newbieCount,
    newbie_approved_weeks_gt_zero_count: newbieApprovedWeeksGtZero,
    newbie_cumulative_weeks_gt_zero_count: newbieCumulativeWeeksGtZero,
    team_counts: [...teamCounts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  }, null, 2));

  if (invalid.length > 0 || forbiddenMediaPlanning.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
