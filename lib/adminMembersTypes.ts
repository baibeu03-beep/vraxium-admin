// Browser-safe constants and types for the /admin/members view.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

export type AdminMemberDto = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  growthStatus: string | null;
  role: string | null;
  // user_memberships(is_current=true) 의 비정규화 값 (읽기 전용 — 트리거가 동기화).
  currentTeamName: string | null;
  currentPartName: string | null;
  // 전체기간 포인트 집계 = user_weekly_points 직접합산(시즌/주차/타입 무필터).
  // user_profiles 에는 캐시 컬럼이 없어 listMembers 가 집계해 채운다(읽기 전용).
  // 이력서 카드의 누적 포인트와 동일한 단일 SoT 합산이며, null 은 0 으로 합산한다.
  //   checkPoints     = SUM(points)      (이력서 "별")
  //   advantagePoints = SUM(advantages)
  //   penaltyPoints   = SUM(penalty)
  checkPoints: number;
  advantagePoints: number;
  penaltyPoints: number;
  createdAt: string | null;
  updatedAt: string | null;
};

// 멤버 관리 UI/API 에서 지정 가능한 역할 4종.
// user_profiles.role CHECK(7종) 의 부분집합이며, ambassador/admin/super_admin 은
// 기존 시스템 보존용이라 이 화면에서는 다루지 않는다(노출/지정 모두 불가).
export const MEMBER_ASSIGNABLE_ROLES = [
  "crew", // 일반 멤버
  "agent",
  "part_leader",
  "team_leader",
] as const;
export type MemberAssignableRole = (typeof MEMBER_ASSIGNABLE_ROLES)[number];

export function isMemberAssignableRole(
  value: unknown,
): value is MemberAssignableRole {
  return (
    typeof value === "string" &&
    (MEMBER_ASSIGNABLE_ROLES as readonly string[]).includes(value)
  );
}

// 같은 파트/팀 안에서 최대 1명만 허용되는 역할 (유일성 검증 대상).
export const PART_UNIQUE_ROLES = ["agent", "part_leader"] as const;
export const TEAM_UNIQUE_ROLES = ["team_leader"] as const;

// 정렬 가능한 컬럼 whitelist. 임의 컬럼명을 그대로 order() 에 넘기지 않는다.
// check_points / advantage_points / penalty_points 는 user_profiles 컬럼이 아니라
// user_weekly_points 집계라서 DB .order() 로는 정렬할 수 없다. listMembers 가 이
// 키들을 별도 경로(전체 집계 후 메모리 정렬)로 처리한다.
export const MEMBER_SORT_COLUMNS = [
  "display_name",
  "contact_email",
  "auth_email",
  "organization_slug",
  "status",
  "growth_status",
  "check_points",
  "advantage_points",
  "penalty_points",
  "created_at",
  "updated_at",
] as const;
export type MemberSortColumn = (typeof MEMBER_SORT_COLUMNS)[number];
export type MemberSortDir = "asc" | "desc";

export function isMemberSortColumn(value: string): value is MemberSortColumn {
  return (MEMBER_SORT_COLUMNS as readonly string[]).includes(value);
}

export type PresenceFilter = "has" | "missing";

export const ORG_NONE_SENTINEL = "__none__";

export const MEMBER_PATCH_FIELDS = [
  "organization_slug",
  "status",
  "growth_status",
  "contact_email",
  "contact_phone",
] as const;
export type MemberPatchField = (typeof MEMBER_PATCH_FIELDS)[number];

export type ListMembersOptions = {
  query?: string | null;
  organization?: string | null; // "__none__" 이면 organization_slug IS NULL
  status?: string | null;
  growthStatus?: string | null;
  authEmailPresence?: PresenceFilter | null;
  contactEmailPresence?: PresenceFilter | null;
  sortBy?: MemberSortColumn | null;
  sortDir?: MemberSortDir | null;
  limit?: number;
  offset?: number;
};

export type ListMembersResult = {
  members: AdminMemberDto[];
  total: number;
  withoutOrganizationCount: number;
  withoutAuthEmailCount: number;
  limit: number;
  offset: number;
};
