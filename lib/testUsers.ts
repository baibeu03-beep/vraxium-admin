import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATION_LABEL, isOrganizationSlug } from "@/lib/organizations";

// 데모/테스트 대상 유저 source of truth = public.test_user_markers.
// ─────────────────────────────────────────────────────────────────────
// user_profiles 에는 is_test_user 컬럼이 없다. 테스트 대상은 seed 시점에
// test_user_markers (user_id → user_profiles.user_id, user_type, note,
// seed_batch_id, legacy_user_id) 에만 기록된다. 따라서 "이 유저가 데모 대상인가"
// 판정과 데모 유저 목록 조회는 모두 이 테이블을 기준으로 한다.
//   → 실 운영 사용자 전체가 노출되지 않고, marker 가 찍힌 유저만 데모 대상이 된다.
// ─────────────────────────────────────────────────────────────────────

export type TestUserDto = {
  userId: string;
  name: string;
  email: string | null;
  seasonName: string | null;
  teamName: string | null;
  partName: string | null;
  roleLabel: string | null;
  status: string | null;
  growthStatus: string | null;
  organizationSlug: string | null;
  // organizationSlug 의 표시 라벨 (encre→Encre 등). slug 가 없으면 null.
  // 고객 페이지 경로 분기는 organizationSlug 기준, 표시는 organizationName 기준.
  organizationName: string | null;
  userType: string | null;
  legacyUserId: string | null;
};

// organization_slug → 표시 라벨. 알려진 slug 면 ORGANIZATION_LABEL, 아니면 slug 원문, 없으면 null.
function organizationNameFromSlug(slug: string | null): string | null {
  if (!slug) return null;
  return isOrganizationSlug(slug) ? ORGANIZATION_LABEL[slug] : slug;
}

type MarkerRow = {
  user_id: string;
  user_type: string | null;
  legacy_user_id: number | string | null;
};

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  contact_email: string | null;
  status: string | null;
  growth_status: string | null;
  organization_slug: string | null;
};

type MembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

type SeasonRow = {
  name: string | null;
  started_at: string | null;
  ended_at: string | null;
  season_index: number | null;
};

// 현재 시즌 선택 규칙: ended_at IS NULL 우선 → started_at DESC → season_index DESC
// (seed-step1 Q15 에서 확정한 규칙과 동일). 시즌별 per-user 매핑 없이 단일 현재
// 시즌명을 목록 전체에 적용한다 — 테스트 유저는 모두 현재 시즌 seed 대상이다.
async function resolveCurrentSeasonName(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("seasons")
    .select("name,started_at,ended_at,season_index");
  if (error || !data || data.length === 0) return null;

  const rows = data as unknown as SeasonRow[];
  const sorted = [...rows].sort((a, b) => {
    const openDelta =
      Number(a.ended_at === null ? 0 : 1) - Number(b.ended_at === null ? 0 : 1);
    if (openDelta !== 0) return openDelta;
    const startDelta = (b.started_at ?? "").localeCompare(a.started_at ?? "");
    if (startDelta !== 0) return startDelta;
    return (b.season_index ?? 0) - (a.season_index ?? 0);
  });
  return sorted[0]?.name ?? null;
}

function pickCurrentMembership(rows: MembershipRow[]): MembershipRow | undefined {
  return [...rows].sort((a, b) => {
    const currentDelta =
      Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (currentDelta !== 0) return currentDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// 단건 판정: profileUserId 가 데모 대상(test_user_markers 등재)인가.
export async function isTestUser(profileUserId: string): Promise<boolean> {
  const id = String(profileUserId ?? "").trim();
  if (!id) return false;
  const { data, error } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .eq("user_id", id)
    .maybeSingle();
  if (error) {
    console.error("[testUsers] isTestUser lookup failed", {
      userId: id,
      error: error.message,
    });
    return false;
  }
  return Boolean(data);
}

// 데모 대상 유저 목록 (test_user_markers ⨝ user_profiles ⨝ user_memberships).
export async function listTestUsers(): Promise<TestUserDto[]> {
  const markerRes = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id,user_type,legacy_user_id");
  if (markerRes.error) throw new Error(markerRes.error.message);

  const markers = (markerRes.data ?? []) as unknown as MarkerRow[];
  if (markers.length === 0) return [];

  const userIds = markers.map((m) => m.user_id);

  const [profilesRes, membershipsRes, seasonName] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select(
        "user_id,display_name,auth_email,contact_email,status,growth_status,organization_slug",
      )
      .in("user_id", userIds),
    supabaseAdmin
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,is_current,updated_at")
      .in("user_id", userIds),
    resolveCurrentSeasonName(),
  ]);

  if (profilesRes.error) throw new Error(profilesRes.error.message);
  if (membershipsRes.error) throw new Error(membershipsRes.error.message);

  const profileById = new Map<string, ProfileRow>();
  for (const row of (profilesRes.data ?? []) as unknown as ProfileRow[]) {
    profileById.set(row.user_id, row);
  }

  const membershipsByUser = new Map<string, MembershipRow[]>();
  for (const row of (membershipsRes.data ?? []) as unknown as MembershipRow[]) {
    const list = membershipsByUser.get(row.user_id) ?? [];
    list.push(row);
    membershipsByUser.set(row.user_id, list);
  }

  return markers.map((marker) => {
    const profile = profileById.get(marker.user_id) ?? null;
    const membership = pickCurrentMembership(
      membershipsByUser.get(marker.user_id) ?? [],
    );

    return {
      userId: marker.user_id,
      name: profile?.display_name?.trim() || marker.user_id,
      email: profile?.auth_email ?? profile?.contact_email ?? null,
      seasonName,
      teamName: membership?.team_name ?? null,
      partName: membership?.part_name ?? null,
      roleLabel: membership?.membership_level ?? null,
      status: profile?.status ?? null,
      growthStatus: profile?.growth_status ?? null,
      organizationSlug: profile?.organization_slug ?? null,
      organizationName: organizationNameFromSlug(profile?.organization_slug ?? null),
      userType: marker.user_type ?? null,
      legacyUserId:
        marker.legacy_user_id == null ? null : String(marker.legacy_user_id),
    } satisfies TestUserDto;
  });
}
