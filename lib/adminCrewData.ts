import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { excludeSuperAdmins } from "@/lib/superAdmins";
import { resolveUserScope, type UserScope } from "@/lib/userScope";
import type { ScopeMode } from "@/lib/userScopeShared";

// Crews source of truth
// ─────────────────────────────────────────────────────────────────────
// 조직 membership canonical = `user_profiles.organization_slug`.
//   - DTO 한 row = `user_profiles` 한 row
//   - `legacy_crew_import` 는 더 이상 row source 가 아니며, 운영 메타데이터
//     (is_visible, admin_note, cumulative_weeks) 만 enrich 한다.
//   - 신규 소셜 로그인 승인 사용자는 user_profiles 만 있으면 즉시 crews 목록에 노출된다.
//   - 식별자(`legacyUserId`)는 `user_profiles.user_id` (UUID) 를 사용한다.
//     URL/route 호환을 위해 필드명을 유지하지만 의미는 "crew identifier" 이다.
// ─────────────────────────────────────────────────────────────────────

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  english_name: string | null;
  gender: string | null;
  birth_date: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  auth_email: string | null;
  status: string | null;
  growth_status: string | null;
  profile_photo_url: string | null;
  school_name: string | null;
  department_name: string | null;
  organization_slug: string | null;
  role: string | null;
  // 비정규화된 현재 팀/파트 — membership 행에 team_name 이 전혀 없을 때의 최종 폴백(고객앱 resolver 규칙 5).
  current_team_name: string | null;
  current_part_name: string | null;
  updated_at: string | null;
};

type UsersRow = {
  id: string;
  legacy_user_id: number | string | null;
  // B안 복합키 (2026-06-07): 이관 provenance. legacy_crew_import graft 가드에 사용.
  source_system: string | null;
};

// legacy_crew_import 는 olympus(phalanx) 1회 임포트 산출물 (전 34행 = legacy 248~309 실측,
// false-bridge-34-census-20260607). B안 복합키 체계에서 같은 legacy_user_id 숫자가
// 소스별로 공존하므로, source_system 이 NULL(이관 전 기존 행) 또는 'olympus' 인 사용자에게만
// legacy 메타를 graft 한다 — oranke/hrdb 이관 행이 숫자가 겹쳐도 오연결되지 않는다.
const LEGACY_CREW_IMPORT_SOURCE = "olympus";
export const canGraftLegacyCrewImport = (
  sourceSystem: string | null | undefined,
) => sourceSystem == null || sourceSystem === LEGACY_CREW_IMPORT_SOURCE;

type LegacyCrewRow = {
  legacy_user_id: number | string;
  display_name: string | null;
  birth_date: string | null;
  gender: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  school_name: string | null;
  major_name: string | null;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  membership_state: string | null;
  cumulative_weeks: number | null;
  is_visible: boolean | null;
  admin_note: string | null;
  updated_at: string | null;
};

type UserMembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  membership_state: string | null;
  is_current: boolean | null;
  updated_at?: string | null;
};

type UserEducationRow = {
  user_id: string;
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number | null;
  is_primary: boolean | null;
  updated_at?: string | null;
};

type UserGrowthStatsRow = {
  user_id: string;
  cumulative_weeks: number | null;
  approved_weeks: number | null;
};

export type AdminCrewDto = {
  id: string;
  legacyUserId: string;
  userId: string;
  usersLegacyUserId: string | null;
  displayName: string;
  name: string;
  englishName: string | null;
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  contactPhone: string | null;
  contactEmail: string | null;
  authEmail: string | null;
  status: string | null;
  growthStatus: string | null;
  schoolName: string | null;
  departmentName: string | null;
  majorName: string | null;
  university: string | null;
  major: string | null;
  universityMajor: string | null;
  teamName: string | null;
  team: string | null;
  partName: string | null;
  part: string | null;
  membershipLevel: string | null;
  membershipState: string | null;
  approvedWeeks: number | null;
  cumulativeWeeks: number | null;
  organizationSlug: string | null;
  role: string | null;
  profilePhotoUrl: string | null;
  isVisible: boolean;
  adminNote: string | null;
  updatedAt: string | null;
};

const PROFILE_SELECT = [
  "user_id",
  "display_name",
  "english_name",
  "gender",
  "birth_date",
  "contact_phone",
  "contact_email",
  "auth_email",
  "status",
  "growth_status",
  "profile_photo_url",
  "school_name",
  "department_name",
  "organization_slug",
  "role",
  "current_team_name",
  "current_part_name",
  "updated_at",
].join(",");

const USERS_SELECT = ["id", "legacy_user_id", "source_system"].join(",");

const LEGACY_SELECT = [
  "legacy_user_id",
  "display_name",
  "birth_date",
  "gender",
  "contact_phone",
  "contact_email",
  "school_name",
  "major_name",
  "team_name",
  "part_name",
  "membership_level",
  "membership_state",
  "cumulative_weeks",
  "is_visible",
  "admin_note",
  "updated_at",
].join(",");

const MEMBERSHIP_SELECT = [
  "user_id",
  "team_name",
  "part_name",
  "membership_level",
  "membership_state",
  "is_current",
  "updated_at",
].join(",");

const EDUCATION_SELECT = [
  "user_id",
  "school_name",
  "major_name_1",
  "sort_order",
  "is_primary",
  "updated_at",
].join(",");

const GROWTH_SELECT = ["user_id", "cumulative_weeks", "approved_weeks"].join(",");

function preferString(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function preferNumber(...values: Array<number | null | undefined>) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function computeAge(birthDate: string | null) {
  if (!birthDate) return null;
  const today = new Date();
  const birth = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(birth.getTime())) return null;

  let age = today.getFullYear() - birth.getFullYear();
  const hasHadBirthday =
    today.getMonth() > birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() >= birth.getDate());
  if (!hasHadBirthday) age -= 1;
  return age >= 0 ? age : null;
}

function membershipHasTeam(row: UserMembershipRow): boolean {
  return typeof row.team_name === "string" && row.team_name.trim() !== "";
}

// 고객앱과 동일한 membership 선택 resolver.
// 일부 실사용자는 is_current=true 행의 team_name 이 NULL 이고, 실제 팀/파트는 is_current=false
// 행에 들어있다. is_current 만으로 정렬하면 NULL 행이 뽑혀 team/part 가 비고, 그 값이 그대로
// weekly-cards snapshot 에 저장된다(고객앱 프록시가 응답 시점에만 보강 → snapshot 자체는 오염).
// 그래서 "team_name 보유 여부"를 is_current 보다 우선한다.
//   우선순위 (작을수록 우선):
//     0) is_current=true && team_name 존재
//     1) team_name 존재
//     2) is_current=true
//     3) 그 외(첫 행)
//   같은 등급 안에서는 updated_at 최신 우선(안정적 tie-break).
// (user_profiles.current_team_name/current_part_name fallback 은 buildAdminCrewDtos 의 preferString
//  체인에서 처리 — 어떤 membership 행도 team_name 이 없을 때의 최종 폴백.)
function membershipRank(row: UserMembershipRow): number {
  const isCurrent = Boolean(row.is_current);
  const hasTeam = membershipHasTeam(row);
  if (isCurrent && hasTeam) return 0;
  if (hasTeam) return 1;
  if (isCurrent) return 2;
  return 3;
}

function pickBestMembership(rows: UserMembershipRow[]) {
  return [...rows].sort((a, b) => {
    const rankDelta = membershipRank(a) - membershipRank(b);
    if (rankDelta !== 0) return rankDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

function pickBestEducation(rows: UserEducationRow[]) {
  return [...rows].sort((a, b) => {
    const primaryDelta = Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
    if (primaryDelta !== 0) return primaryDelta;
    const sortDelta = (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
    if (sortDelta !== 0) return sortDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

type CrewSourceRows = {
  profiles: UserProfileRow[];
  users: UsersRow[];
  legacyRows: LegacyCrewRow[];
  memberships: UserMembershipRow[];
  educations: UserEducationRow[];
  growthStats: UserGrowthStatsRow[];
};

// PostgREST 의 .in() 은 id 들을 URL 쿼리스트링에 그대로 나열한다 — 로스터 전체(700+)면
// 쿼리스트링이 ~27KB 까지 커져 URL 길이 한계를 넘고 "Bad Request"/fetch failed 로 500 이 난다.
// user_id 를 청크로 나눠 조회 후 병합한다(결과 동일·snapshot-only 무관). 청크 단위 실패는
// 어느 테이블·어느 구간인지 메시지에 박아 원인을 정확히 남긴다.
const ROSTER_IN_CHUNK = 150;
async function fetchByIdsChunked<T>(
  table: string,
  select: string,
  column: string,
  ids: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ROSTER_IN_CHUNK) {
    const chunk = ids.slice(i, i + ROSTER_IN_CHUNK);
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(select)
      .in(column, chunk);
    if (error) {
      throw new Error(
        `[fetchCrewSourceRows] ${table}.in(${column}) 청크 실패 [${i}-${i + chunk.length}/${ids.length}]: ${error.message}`,
      );
    }
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

async function fetchCrewSourceRows(options: {
  organization?: OrganizationSlug;
  userId?: string;
  // 모집단 스코프(operating=테스트 제외 / test=테스트만). SoT=test_user_markers(userScope).
  // 목록 조회에만 적용 — 단건 user_id 조회(POST 후 정규화 등)는 노출 목록이 아니라 무관.
  scope?: UserScope;
}): Promise<CrewSourceRows> {
  let profileQuery = supabaseAdmin
    .from("user_profiles")
    .select(PROFILE_SELECT);

  if (options.organization) {
    profileQuery = profileQuery.eq("organization_slug", options.organization);
  }
  if (options.userId) {
    profileQuery = profileQuery.eq("user_id", options.userId);
  } else {
    // 크루 "목록" 조회 시 super admin 제외. 단건 user_id 조회(POST 후 정규화 등)는
    // 노출 목록이 아니므로 그대로 둔다 — super admin 의 단건 조회/권한에는 영향 없음.
    profileQuery = excludeSuperAdmins(profileQuery);
  }

  const profileRes = await profileQuery;
  if (profileRes.error) throw new Error(profileRes.error.message);

  const fetchedProfiles = (profileRes.data ?? []) as unknown as UserProfileRow[];
  // 목록 경로에서만 스코프 필터(test_user_markers). 단건 userId 조회는 그대로.
  // 여기서 좁혀두면 이후 users/membership/education/growth 보강 쿼리가 실사용자(또는
  // 테스트 유저)만 대상으로 돌아 불필요한 행을 끌어오지 않는다.
  const profiles =
    options.scope && !options.userId
      ? options.scope.filter(fetchedProfiles, (p) => p.user_id)
      : fetchedProfiles;
  if (profiles.length === 0) {
    return {
      profiles: [],
      users: [],
      legacyRows: [],
      memberships: [],
      educations: [],
      growthStats: [],
    };
  }

  const userIds = profiles.map((profile) => profile.user_id);

  // .in() URL 길이 한계 회피 — user_id 청크 분할 조회(병렬 4종, 각 테이블 내부는 순차 청크).
  const [users, memberships, educations, growthStats] = await Promise.all([
    fetchByIdsChunked<UsersRow>("users", USERS_SELECT, "id", userIds),
    fetchByIdsChunked<UserMembershipRow>("user_memberships", MEMBERSHIP_SELECT, "user_id", userIds),
    fetchByIdsChunked<UserEducationRow>("user_educations", EDUCATION_SELECT, "user_id", userIds),
    fetchByIdsChunked<UserGrowthStatsRow>("user_growth_stats", GROWTH_SELECT, "user_id", userIds),
  ]);

  // graft 대상 후보만 수집 — olympus 외 소스 이관 행은 숫자가 겹쳐도 조회 자체를 배제.
  const legacyUserIds = users
    .filter((row) => canGraftLegacyCrewImport(row.source_system))
    .map((row) => row.legacy_user_id)
    .filter((id): id is number | string => id !== null && id !== undefined)
    .map((id) => String(id));

  let legacyRows: LegacyCrewRow[] = [];
  if (legacyUserIds.length > 0) {
    legacyRows = await fetchByIdsChunked<LegacyCrewRow>(
      "legacy_crew_import", LEGACY_SELECT, "legacy_user_id", legacyUserIds,
    );
  }

  return { profiles, users, legacyRows, memberships, educations, growthStats };
}

function buildAdminCrewDtos(rows: CrewSourceRows): AdminCrewDto[] {
  const userById = new Map(rows.users.map((row) => [row.id, row]));
  const legacyByLegacyId = new Map(
    rows.legacyRows.map((row) => [String(row.legacy_user_id), row]),
  );

  const membershipsByUserId = new Map<string, UserMembershipRow[]>();
  for (const row of rows.memberships) {
    const list = membershipsByUserId.get(row.user_id) ?? [];
    list.push(row);
    membershipsByUserId.set(row.user_id, list);
  }

  const educationsByUserId = new Map<string, UserEducationRow[]>();
  for (const row of rows.educations) {
    const list = educationsByUserId.get(row.user_id) ?? [];
    list.push(row);
    educationsByUserId.set(row.user_id, list);
  }

  const growthByUserId = new Map(
    rows.growthStats.map((row) => [row.user_id, row]),
  );

  return rows.profiles.map((profile) => {
    const userRow = userById.get(profile.user_id);
    const usersLegacyUserId =
      userRow?.legacy_user_id != null ? String(userRow.legacy_user_id) : null;
    // B안 복합키: legacy_crew_import(olympus 임포트) graft 는 source_system 이
    // NULL/'olympus' 인 사용자에게만 — oranke/hrdb 이관 행 숫자 충돌 오연결 차단.
    const legacy =
      usersLegacyUserId && canGraftLegacyCrewImport(userRow?.source_system)
        ? legacyByLegacyId.get(usersLegacyUserId) ?? null
        : null;

    const membership = pickBestMembership(membershipsByUserId.get(profile.user_id) ?? []);
    const education = pickBestEducation(educationsByUserId.get(profile.user_id) ?? []);
    const growth = growthByUserId.get(profile.user_id);

    const displayName = preferString(
      profile.display_name,
      legacy?.display_name,
      profile.contact_email,
      profile.user_id,
    )!;

    const schoolName = preferString(
      education?.school_name,
      profile.school_name,
      legacy?.school_name,
    );
    const departmentName = preferString(
      education?.major_name_1,
      profile.department_name,
      legacy?.major_name,
    );
    // 고객앱 resolver 규칙 5: membership 행에 team/part 가 전혀 없으면 user_profiles 의
    // 비정규화 current_team_name/current_part_name 으로 폴백(legacy 보다 우선 — profile 이 정본에 가깝다).
    const teamName = preferString(
      membership?.team_name,
      profile.current_team_name,
      legacy?.team_name,
    );
    const partName = preferString(
      membership?.part_name,
      profile.current_part_name,
      legacy?.part_name,
    );
    const membershipLevel = preferString(
      membership?.membership_level,
      legacy?.membership_level,
    );
    const membershipState = preferString(
      membership?.membership_state,
      legacy?.membership_state,
    );
    const cumulativeWeeks = preferNumber(
      growth?.cumulative_weeks,
      legacy?.cumulative_weeks,
    );
    const approvedWeeks = preferNumber(growth?.approved_weeks);
    const birthDate = preferString(profile.birth_date, legacy?.birth_date);

    return {
      id: profile.user_id,
      legacyUserId: profile.user_id,
      userId: profile.user_id,
      usersLegacyUserId,
      displayName,
      name: displayName,
      englishName: preferString(profile.english_name),
      gender: preferString(profile.gender, legacy?.gender),
      birthDate,
      age: computeAge(birthDate),
      contactPhone: preferString(profile.contact_phone, legacy?.contact_phone),
      contactEmail: preferString(profile.contact_email, legacy?.contact_email),
      authEmail: profile.auth_email ?? null,
      status: profile.status ?? null,
      growthStatus: profile.growth_status ?? null,
      schoolName,
      departmentName,
      majorName: departmentName,
      university: schoolName,
      major: departmentName,
      universityMajor:
        schoolName && departmentName
          ? `${schoolName} / ${departmentName}`
          : schoolName ?? departmentName,
      teamName,
      team: teamName,
      partName,
      part: partName,
      membershipLevel,
      membershipState,
      approvedWeeks,
      cumulativeWeeks,
      organizationSlug: profile.organization_slug ?? null,
      role: profile.role ?? null,
      profilePhotoUrl: profile.profile_photo_url ?? null,
      isVisible: legacy?.is_visible ?? true,
      adminNote: legacy?.admin_note ?? null,
      updatedAt: preferString(profile.updated_at, legacy?.updated_at),
    } satisfies AdminCrewDto;
  });
}

export async function listAdminCrewDtos(
  organization?: OrganizationSlug,
  mode: ScopeMode = "operating",
) {
  // operating(기본)=실사용자만(테스트 제외) / test=test_user_markers 만. team 컨텍스트 불필요.
  const scope = await resolveUserScope(mode, organization ?? null);
  const rows = await fetchCrewSourceRows({ organization, scope });
  return buildAdminCrewDtos(rows).sort((a, b) => {
    if (a.isVisible !== b.isVisible) return Number(b.isVisible) - Number(a.isVisible);
    const teamCompare = (a.teamName ?? "").localeCompare(b.teamName ?? "", "ko");
    if (teamCompare !== 0) return teamCompare;
    return a.displayName.localeCompare(b.displayName, "ko");
  });
}

// crew id = user_profiles.user_id (UUID).
// [legacy_user_id] 라우트 파라미터 폴더명은 historical 이지만 실제 값은 UUID 다.
// legacy_user_id(bigint) 기반 lookup 은 제거 — 매칭 실패 시 null.
export async function getAdminCrewDtoByLegacyUserId(routeParam: string) {
  const id = String(routeParam).trim();
  if (!id) return null;

  const rows = await fetchCrewSourceRows({ userId: id });
  if (rows.profiles.length === 0) return null;
  return buildAdminCrewDtos(rows)[0] ?? null;
}

// 어드민 화면 상단/breadcrumb 등에서 회원명을 노출하기 위한 경량 lookup.
// 전체 crew DTO 를 빌드할 필요 없을 때 1-row select 만으로 끝낸다.
// 매칭 row 가 없으면 null — 호출자는 fallback (예: ID) 을 직접 결정한다.
export async function getMemberDisplayName(userId: string) {
  const id = String(userId ?? "").trim();
  if (!id) return null;
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("display_name")
    .eq("user_id", id)
    .maybeSingle();
  if (error) {
    console.error("[admin] getMemberDisplayName failed", { userId: id, error });
    return null;
  }
  const name = (data as { display_name: string | null } | null)?.display_name;
  return name && name.trim() !== "" ? name : null;
}

// users.legacy_user_id 를 user_profiles.user_id 로 변환 (없으면 null).
// PATCH 경로에서 legacy_crew_import row 를 upsert 할 때 사용한다.
export async function getUsersLegacyUserIdByUserId(userId: string) {
  const identity = await getUsersLegacyIdentityByUserId(userId);
  return identity?.legacyUserId ?? null;
}

// B안 복합키 (2026-06-07): legacy_user_id 와 이관 provenance(source_system) 를 함께 반환.
// legacy_crew_import 접근 가드(canGraftLegacyCrewImport) 판단에 사용 — UUID 기준 단건 조회.
export async function getUsersLegacyIdentityByUserId(
  userId: string,
): Promise<{ legacyUserId: string | null; sourceSystem: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("legacy_user_id,source_system")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as { legacy_user_id: number | string | null; source_system: string | null };
  return {
    legacyUserId: row.legacy_user_id == null ? null : String(row.legacy_user_id),
    sourceSystem: row.source_system ?? null,
  };
}
