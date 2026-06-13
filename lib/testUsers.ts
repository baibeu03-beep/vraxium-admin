import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATION_LABEL, isOrganizationSlug } from "@/lib/organizations";
import { SUPER_ADMIN_ROLE } from "@/lib/superAdmins";
import { normalizeMemberRole } from "@/lib/adminMembersTypes";

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
  // 임퍼소네이션 버튼 게이팅용(additive) — user_profiles.role + membership_level 정규화.
  //   roleLabel(raw level)만으로는 team_leader/crew·part_leader/agent 구분 불가 → 별도 제공.
  memberRole: "team_leader" | "part_leader" | "agent" | "member";
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
  role: string | null;
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

// 현재 시즌 선택 규칙 (2026-06-07 정책 확정: 오늘 날짜가 포함된 시즌 기준):
//   1) started_at <= 오늘 인 행만 후보 — 미래 시즌(기간 등록 선등록분)은 절대 선택하지 않는다.
//      (종전 started_at DESC 규칙은 미래 seasons 행이 생기면 현재 시즌이 조기 flip 되는 결함)
//   2) 후보 중 오늘을 포함(ended_at IS NULL 또는 오늘 <= ended_at)하는 행 우선.
//   3) 동순위는 started_at DESC → season_index DESC.
// 시즌별 per-user 매핑 없이 단일 현재 시즌명을 목록 전체에 적용한다 —
// 테스트 유저는 모두 현재 시즌 seed 대상이다.
async function resolveCurrentSeasonName(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("seasons")
    .select("name,started_at,ended_at,season_index");
  if (error || !data || data.length === 0) return null;

  const nowIso = new Date().toISOString();
  const rows = (data as unknown as SeasonRow[]).filter(
    (r) => r.started_at != null && r.started_at <= nowIso,
  );
  const containsToday = (r: SeasonRow) =>
    r.ended_at === null || nowIso <= r.ended_at;
  const sorted = [...rows].sort((a, b) => {
    const todayDelta = Number(containsToday(b)) - Number(containsToday(a));
    if (todayDelta !== 0) return todayDelta;
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

// 시드 테스트 유저 user_id 집합 (test_user_markers 전수). 집계/코호트에서 테스트 유저를
// 일괄 제외할 때 쓰는 단일 SoT 접근자 — isTestUser(단건)와 같은 테이블을 본다(중복 기준 금지).
//   ⚠ display_name ILIKE '%T%' 휴리스틱(레거시)이 아니라 test_user_markers 등재만 기준으로 한다.
//   조회 실패 시 빈 집합(보수적: 아무도 제외하지 않음 — 실유저 누락보다 안전).
export async function fetchTestUserMarkerIds(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id");
  if (error) {
    console.error("[testUsers] fetchTestUserMarkerIds failed", { error: error.message });
    return new Set();
  }
  return new Set(
    ((data ?? []) as { user_id: string }[])
      .map((r) => r.user_id)
      .filter((id): id is string => Boolean(id)),
  );
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
        "user_id,display_name,auth_email,contact_email,status,growth_status,organization_slug,role",
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

  // super admin 은 테스트 유저 목록에서 제외 (목록 노출에서만 숨김 — 인가와 무관).
  // marker 가 찍혀 있더라도 role='super_admin' 이면 출력하지 않는다.
  const visibleMarkers = markers.filter(
    (m) => profileById.get(m.user_id)?.role !== SUPER_ADMIN_ROLE,
  );

  const membershipsByUser = new Map<string, MembershipRow[]>();
  for (const row of (membershipsRes.data ?? []) as unknown as MembershipRow[]) {
    const list = membershipsByUser.get(row.user_id) ?? [];
    list.push(row);
    membershipsByUser.set(row.user_id, list);
  }

  return visibleMarkers.map((marker) => {
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
      memberRole: normalizeMemberRole(
        profile?.role ?? null,
        membership?.membership_level ?? null,
      ),
    } satisfies TestUserDto;
  });
}
