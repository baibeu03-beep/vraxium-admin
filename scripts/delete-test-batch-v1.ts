import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const TARGET_SEED_BATCH_ID = "2026-05-22_seed_30users_v1";
const KEEP_SEED_BATCH_ID = "2026-05-26_seed_90users_v2";
const LEGACY_MIN = 900001;
const LEGACY_MAX = 900030;

type Marker = {
  user_id: string;
  seed_batch_id: string;
  legacy_user_id: number;
  user_type: string | null;
};

type Profile = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  organization_slug: string | null;
};

type UserRow = {
  id: string;
  legacy_user_id: number | string | null;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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

async function countByIn(table: string, column: string, values: string[]) {
  if (values.length === 0) return { table, column, count: 0, skipped: false };

  const { count, error } = await supabase
    .from(table)
    .select("*", { count: "exact", head: true })
    .in(column, values);

  if (error) {
    return { table, column, count: null, skipped: true, error: error.message };
  }

  return { table, column, count: count ?? 0, skipped: false };
}

async function deleteByIn(table: string, column: string, values: string[]) {
  if (values.length === 0) return { table, column, deleted: 0, skipped: false };

  const before = await countByIn(table, column, values);
  if (before.skipped) return { ...before, deleted: null };

  const { error } = await supabase
    .from(table)
    .delete()
    .in(column, values);

  if (error) {
    throw new Error(`${table}.${column} delete failed: ${error.message}`);
  }

  return {
    table,
    column,
    deleted: before.count,
    skipped: false,
  };
}

async function loadTargets() {
  const markers = await selectAll<Marker>(
    "test_user_markers",
    "user_id,seed_batch_id,legacy_user_id,user_type",
    (q) => q
      .eq("seed_batch_id", TARGET_SEED_BATCH_ID)
      .gte("legacy_user_id", LEGACY_MIN)
      .lte("legacy_user_id", LEGACY_MAX),
  );

  const userIds = markers.map((marker) => marker.user_id);
  const [profiles, users] = userIds.length === 0
    ? [[], []] as [Profile[], UserRow[]]
    : await Promise.all([
      selectAll<Profile>(
        "user_profiles",
        "user_id,display_name,auth_email,contact_email,contact_phone,organization_slug",
        (q) => q.in("user_id", userIds),
      ),
      selectAll<UserRow>(
        "users",
        "id,legacy_user_id",
        (q) => q.in("id", userIds),
      ),
    ]);

  const profileByUserId = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const userById = new Map(users.map((user) => [user.id, user]));

  const targets = markers
    .map((marker) => ({
      marker,
      profile: profileByUserId.get(marker.user_id) ?? null,
      user: userById.get(marker.user_id) ?? null,
    }))
    .sort((a, b) => a.marker.legacy_user_id - b.marker.legacy_user_id);

  return { markers, profiles, users, targets, userIds };
}

function assertSafeTargets(targets: Awaited<ReturnType<typeof loadTargets>>["targets"]) {
  if (targets.length !== 30) {
    throw new Error(`Refusing delete: target count is ${targets.length}, expected 30`);
  }

  const unsafe = targets.filter(({ marker, profile, user }) => {
    const legacyFromUsers = Number(user?.legacy_user_id);
    return (
      marker.seed_batch_id !== TARGET_SEED_BATCH_ID ||
      marker.legacy_user_id < LEGACY_MIN ||
      marker.legacy_user_id > LEGACY_MAX ||
      legacyFromUsers !== marker.legacy_user_id ||
      !profile?.display_name?.includes("[TEST]") ||
      !profile.auth_email?.endsWith("@vraxium.test") ||
      !profile.contact_email?.endsWith("@vraxium.test") ||
      !/^010-9900-\d{4}$/.test(profile.contact_phone ?? "")
    );
  });

  if (unsafe.length > 0) {
    throw new Error(`Refusing delete: ${unsafe.length} targets failed TEST safety checks`);
  }
}

async function countConnectedRows(userIds: string[]) {
  const userIdTables = [
    "admin_users",
    "career_projects",
    "career_records",
    "cluster4_line_submissions",
    "portfolio_channel_cards",
    "portfolio_top_cards",
    "test_user_markers",
    "user_activity_details",
    "user_cluster2",
    "user_club_rank_frozen",
    "user_cumulative_points",
    "user_edit_windows",
    "user_educations",
    "user_grade_stats",
    "user_growth_stats",
    "user_introductions",
    "user_memberships",
    "user_resume_card_settings",
    "user_review_links",
    "user_season_histories",
    "user_week_statuses",
    "user_weekly_points",
    "weekly_reviews",
  ];

  const directCounts = [];
  for (const table of userIdTables) {
    directCounts.push(await countByIn(table, "user_id", userIds));
  }

  const relationCounts = [];
  for (const [table, column] of [
    ["applicants", "linked_user_id"],
    ["cluster4_line_targets", "target_user_id"],
    ["cluster4_experience_line_drafts", "target_user_id"],
    ["weekly_colleagues", "colleague_id"],
    ["weekly_reputations", "reviewer_id"],
    ["weekly_reputations", "target_user_id"],
    ["season_reputations", "reviewer_id"],
    ["season_reputations", "target_user_id"],
    ["users", "id"],
    ["user_profiles", "user_id"],
  ] as const) {
    relationCounts.push(await countByIn(table, column, userIds));
  }

  return [...directCounts, ...relationCounts];
}

async function main() {
  const { targets, userIds } = await loadTargets();
  assertSafeTargets(targets);

  console.log(JSON.stringify({
    delete_target_seed_batch_id: TARGET_SEED_BATCH_ID,
    delete_target_count: targets.length,
    delete_targets: targets.map(({ marker, profile }) => ({
      legacy_user_id: marker.legacy_user_id,
      user_id: marker.user_id,
      display_name: profile?.display_name,
      organization_slug: profile?.organization_slug,
      auth_email: profile?.auth_email,
    })),
  }, null, 2));

  const beforeCounts = await countConnectedRows(userIds);
  console.log(JSON.stringify({ connected_row_counts_before_delete: beforeCounts }, null, 2));

  const deleted = [];

  // Delete child tables first. Tables absent from the PostgREST schema cache are skipped at count time only.
  const deletePlan: Array<[string, string]> = [
    ["weekly_colleagues", "colleague_id"],
    ["weekly_colleagues", "user_id"],
    ["weekly_reputations", "reviewer_id"],
    ["weekly_reputations", "target_user_id"],
    ["season_reputations", "reviewer_id"],
    ["season_reputations", "target_user_id"],
    ["cluster4_line_submissions", "user_id"],
    ["cluster4_experience_line_drafts", "target_user_id"],
    ["cluster4_line_targets", "target_user_id"],
    ["career_records", "user_id"],
    ["career_projects", "user_id"],
    ["portfolio_channel_cards", "user_id"],
    ["portfolio_top_cards", "user_id"],
    ["weekly_reviews", "user_id"],
    ["user_weekly_points", "user_id"],
    ["user_week_statuses", "user_id"],
    ["user_season_histories", "user_id"],
    ["user_review_links", "user_id"],
    ["user_resume_card_settings", "user_id"],
    ["user_introductions", "user_id"],
    ["user_cluster2", "user_id"],
    ["user_educations", "user_id"],
    ["user_edit_windows", "user_id"],
    ["user_grade_stats", "user_id"],
    ["user_club_rank_frozen", "user_id"],
    ["user_cumulative_points", "user_id"],
    ["user_growth_stats", "user_id"],
    ["user_memberships", "user_id"],
    ["applicants", "linked_user_id"],
    ["admin_users", "user_id"],
    ["test_user_markers", "user_id"],
    ["user_profiles", "user_id"],
    ["users", "id"],
  ];

  for (const [table, column] of deletePlan) {
    deleted.push(await deleteByIn(table, column, userIds));
  }

  const afterCounts = await countConnectedRows(userIds);

  const [
    targetMarkersAfter,
    targetUsersAfter,
    targetProfilesAfter,
    keepMarkersAfter,
    allTestProfilesAfter,
  ] = await Promise.all([
    selectAll<Marker>(
      "test_user_markers",
      "user_id,seed_batch_id,legacy_user_id,user_type",
      (q) => q.eq("seed_batch_id", TARGET_SEED_BATCH_ID),
    ),
    selectAll<UserRow>(
      "users",
      "id,legacy_user_id",
      (q) => q.gte("legacy_user_id", LEGACY_MIN).lte("legacy_user_id", LEGACY_MAX),
    ),
    selectAll<Profile>(
      "user_profiles",
      "user_id,display_name,auth_email,contact_email,contact_phone,organization_slug",
      (q) => q.in("user_id", userIds),
    ),
    selectAll<Marker>(
      "test_user_markers",
      "user_id,seed_batch_id,legacy_user_id,user_type",
      (q) => q.eq("seed_batch_id", KEEP_SEED_BATCH_ID),
    ),
    selectAll<Profile>(
      "user_profiles",
      "user_id,display_name,auth_email,contact_email,contact_phone,organization_slug",
      (q) => q.ilike("display_name", "%[TEST]%"),
    ),
  ]);

  console.log(JSON.stringify({
    delete_results: deleted,
    connected_row_counts_after_delete: afterCounts,
    final_verification: {
      target_seed_marker_count: targetMarkersAfter.length,
      users_legacy_900001_900030_count: targetUsersAfter.length,
      deleted_user_profiles_count: targetProfilesAfter.length,
      display_name_like_test_count: allTestProfilesAfter.length,
      keep_seed_marker_count: keepMarkersAfter.length,
    },
  }, null, 2));

  const failed =
    targetMarkersAfter.length !== 0 ||
    targetUsersAfter.length !== 0 ||
    targetProfilesAfter.length !== 0 ||
    allTestProfilesAfter.length !== 90 ||
    keepMarkersAfter.length !== 90;

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
