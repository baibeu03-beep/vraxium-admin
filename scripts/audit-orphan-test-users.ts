import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
  user_type: string | null;
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
        "user_id,seed_batch_id,legacy_user_id,user_type",
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

  const markerByUserId = new Map(markers.map((marker) => [marker.user_id, marker]));
  const membershipByUserId = new Map(
    memberships
      .filter((membership) => membership.is_current !== false)
      .map((membership) => [membership.user_id, membership]),
  );
  const growthByUserId = new Map(growthStats.map((growth) => [growth.user_id, growth]));

  const orphanProfiles = profiles
    .filter((profile) => !markerByUserId.has(profile.user_id))
    .sort((a, b) => {
      const orgCompare = (a.organization_slug ?? "").localeCompare(b.organization_slug ?? "");
      if (orgCompare !== 0) return orgCompare;
      return (a.display_name ?? "").localeCompare(b.display_name ?? "");
    });

  const rows = orphanProfiles.map((profile) => {
    const membership = membershipByUserId.get(profile.user_id);
    const growth = growthByUserId.get(profile.user_id);
    const testSignals = [
      profile.display_name?.includes("[TEST]") ? "display_name" : null,
      profile.auth_email?.endsWith("@vraxium.test") ? "auth_email" : null,
      profile.contact_email?.endsWith("@vraxium.test") ? "contact_email" : null,
      profile.contact_phone?.startsWith("010-99") ? "contact_phone" : null,
    ].filter(Boolean);

    return {
      user_id: profile.user_id,
      display_name: profile.display_name,
      organization_slug: profile.organization_slug,
      team_name: membership?.team_name ?? null,
      auth_email: profile.auth_email,
      contact_email: profile.contact_email,
      contact_phone: profile.contact_phone,
      cumulative_weeks: growth?.cumulative_weeks ?? 0,
      approved_weeks: growth?.approved_weeks ?? 0,
      test_signals: testSignals,
      likely_test_user: testSignals.length >= 2,
    };
  });

  console.log(JSON.stringify({
    display_name_test_profiles: profiles.length,
    marker_registered_profiles: markers.length,
    orphan_test_like_profiles: rows.length,
    rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
