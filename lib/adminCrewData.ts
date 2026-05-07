import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

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

type AdminCrewViewRow = LegacyCrewRow & {
  organization_slug: string | null;
};

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  gender: string | null;
  birth_date: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  profile_photo_url: string | null;
  school_name: string | null;
  department_name: string | null;
  organization_slug: string | null;
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
  userId: string | null;
  displayName: string;
  name: string;
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  contactPhone: string | null;
  contactEmail: string | null;
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
  profilePhotoUrl: string | null;
  isVisible: boolean;
  adminNote: string | null;
  updatedAt: string | null;
};

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

const VIEW_SELECT = `${LEGACY_SELECT},organization_slug`;
const PROFILE_SELECT = [
  "user_id",
  "display_name",
  "gender",
  "birth_date",
  "contact_phone",
  "contact_email",
  "profile_photo_url",
  "school_name",
  "department_name",
  "organization_slug",
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

function toLookupKey(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
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

function pickBestMembership(rows: UserMembershipRow[]) {
  return [...rows].sort((a, b) => {
    const currentDelta = Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (currentDelta !== 0) return currentDelta;
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

function matchProfile(
  legacy: LegacyCrewRow,
  profilesByEmail: Map<string, UserProfileRow>,
  profilesByPhone: Map<string, UserProfileRow>,
  uniqueProfilesByName: Map<string, UserProfileRow>,
) {
  const emailKey = toLookupKey(legacy.contact_email);
  if (emailKey && profilesByEmail.has(emailKey)) return profilesByEmail.get(emailKey) ?? null;

  const phoneKey = toLookupKey(legacy.contact_phone);
  if (phoneKey && profilesByPhone.has(phoneKey)) return profilesByPhone.get(phoneKey) ?? null;

  const nameKey = toLookupKey(legacy.display_name);
  if (nameKey && uniqueProfilesByName.has(nameKey)) {
    return uniqueProfilesByName.get(nameKey) ?? null;
  }

  return null;
}

async function fetchCrewSourceRows() {
  const [viewRes, legacyRes, profilesRes, membershipsRes, educationsRes, growthRes] =
    await Promise.all([
      supabaseAdmin.from("admin_crew_list_view").select(VIEW_SELECT),
      supabaseAdmin.from("legacy_crew_import").select(LEGACY_SELECT),
      supabaseAdmin.from("user_profiles").select(PROFILE_SELECT),
      supabaseAdmin.from("user_memberships").select(MEMBERSHIP_SELECT),
      supabaseAdmin.from("user_educations").select(EDUCATION_SELECT),
      supabaseAdmin.from("user_growth_stats").select(GROWTH_SELECT),
    ]);

  const errors = [
    viewRes.error,
    legacyRes.error,
    profilesRes.error,
    membershipsRes.error,
    educationsRes.error,
    growthRes.error,
  ].filter(Boolean);

  if (errors.length > 0) {
    const message = errors.map((error) => error?.message).join(" | ");
    throw new Error(message);
  }

  return {
    viewRows: (viewRes.data ?? []) as unknown as AdminCrewViewRow[],
    legacyRows: (legacyRes.data ?? []) as unknown as LegacyCrewRow[],
    profiles: (profilesRes.data ?? []) as unknown as UserProfileRow[],
    memberships: (membershipsRes.data ?? []) as unknown as UserMembershipRow[],
    educations: (educationsRes.data ?? []) as unknown as UserEducationRow[],
    growthStats: (growthRes.data ?? []) as unknown as UserGrowthStatsRow[],
  };
}

function buildAdminCrewDtos(rows: Awaited<ReturnType<typeof fetchCrewSourceRows>>) {
  const viewByLegacyUserId = new Map(
    rows.viewRows.map((row) => [String(row.legacy_user_id), row]),
  );
  const profilesByEmail = new Map(
    rows.profiles
      .filter((profile) => profile.contact_email)
      .map((profile) => [toLookupKey(profile.contact_email), profile]),
  );
  const profilesByPhone = new Map(
    rows.profiles
      .filter((profile) => profile.contact_phone)
      .map((profile) => [toLookupKey(profile.contact_phone), profile]),
  );
  const profilesByNameBucket = new Map<string, UserProfileRow[]>();
  for (const profile of rows.profiles) {
    const key = toLookupKey(profile.display_name);
    if (!key) continue;
    profilesByNameBucket.set(key, [...(profilesByNameBucket.get(key) ?? []), profile]);
  }
  const uniqueProfilesByName = new Map<string, UserProfileRow>();
  for (const [key, bucket] of profilesByNameBucket.entries()) {
    if (bucket.length === 1) uniqueProfilesByName.set(key, bucket[0]);
  }

  const membershipsByUserId = new Map<string, UserMembershipRow[]>();
  for (const membership of rows.memberships) {
    membershipsByUserId.set(membership.user_id, [
      ...(membershipsByUserId.get(membership.user_id) ?? []),
      membership,
    ]);
  }

  const educationsByUserId = new Map<string, UserEducationRow[]>();
  for (const education of rows.educations) {
    educationsByUserId.set(education.user_id, [
      ...(educationsByUserId.get(education.user_id) ?? []),
      education,
    ]);
  }

  const growthByUserId = new Map(
    rows.growthStats.map((growth) => [growth.user_id, growth]),
  );

  return rows.legacyRows.map((legacy) => {
    const legacyUserId = String(legacy.legacy_user_id);
    const view = viewByLegacyUserId.get(legacyUserId) ?? null;
    const profile = matchProfile(
      legacy,
      profilesByEmail,
      profilesByPhone,
      uniqueProfilesByName,
    );
    const membership = profile ? pickBestMembership(membershipsByUserId.get(profile.user_id) ?? []) : undefined;
    const education = profile ? pickBestEducation(educationsByUserId.get(profile.user_id) ?? []) : undefined;
    const growth = profile ? growthByUserId.get(profile.user_id) : undefined;

    const displayName = preferString(
      profile?.display_name,
      view?.display_name,
      legacy.display_name,
      legacyUserId,
    )!;
    const schoolName = preferString(
      education?.school_name,
      profile?.school_name,
      view?.school_name,
      legacy.school_name,
    );
    const departmentName = preferString(
      education?.major_name_1,
      profile?.department_name,
      view?.major_name,
      legacy.major_name,
    );
    const teamName = preferString(
      membership?.team_name,
      view?.team_name,
      legacy.team_name,
    );
    const partName = preferString(
      membership?.part_name,
      view?.part_name,
      legacy.part_name,
    );
    const membershipLevel = preferString(
      membership?.membership_level,
      view?.membership_level,
      legacy.membership_level,
    );
    const membershipState = preferString(
      membership?.membership_state,
      view?.membership_state,
      legacy.membership_state,
    );
    const cumulativeWeeks = preferNumber(
      growth?.cumulative_weeks,
      view?.cumulative_weeks,
      legacy.cumulative_weeks,
    );
    const approvedWeeks = preferNumber(growth?.approved_weeks);
    const organizationSlug = preferString(
      profile?.organization_slug,
      view?.organization_slug,
    );

    return {
      id: profile?.user_id ?? legacyUserId,
      legacyUserId,
      userId: profile?.user_id ?? null,
      displayName,
      name: displayName,
      gender: preferString(profile?.gender, view?.gender, legacy.gender),
      birthDate: preferString(profile?.birth_date, view?.birth_date, legacy.birth_date),
      age: computeAge(preferString(profile?.birth_date, view?.birth_date, legacy.birth_date)),
      contactPhone: preferString(
        profile?.contact_phone,
        view?.contact_phone,
        legacy.contact_phone,
      ),
      contactEmail: preferString(
        profile?.contact_email,
        view?.contact_email,
        legacy.contact_email,
      ),
      schoolName,
      departmentName,
      majorName: departmentName,
      university: schoolName,
      major: departmentName,
      universityMajor:
        schoolName && departmentName ? `${schoolName} / ${departmentName}` : schoolName ?? departmentName,
      teamName,
      team: teamName,
      partName,
      part: partName,
      membershipLevel,
      membershipState,
      approvedWeeks,
      cumulativeWeeks,
      organizationSlug,
      profilePhotoUrl: profile?.profile_photo_url ?? null,
      isVisible: view?.is_visible ?? legacy.is_visible ?? false,
      adminNote: preferString(view?.admin_note, legacy.admin_note),
      updatedAt: preferString(view?.updated_at, legacy.updated_at),
    } satisfies AdminCrewDto;
  });
}

export async function listAdminCrewDtos(organization?: OrganizationSlug) {
  const rows = await fetchCrewSourceRows();
  const data = buildAdminCrewDtos(rows)
    .filter((crew) => !organization || crew.organizationSlug === organization)
    .sort((a, b) => {
      if (a.isVisible !== b.isVisible) return Number(b.isVisible) - Number(a.isVisible);
      const teamCompare = (a.teamName ?? "").localeCompare(b.teamName ?? "", "ko");
      if (teamCompare !== 0) return teamCompare;
      return a.displayName.localeCompare(b.displayName, "ko");
    });

  return data;
}

export async function getAdminCrewDtoByLegacyUserId(legacyUserId: string) {
  const crews = await listAdminCrewDtos();
  return crews.find((crew) => crew.legacyUserId === String(legacyUserId)) ?? null;
}
