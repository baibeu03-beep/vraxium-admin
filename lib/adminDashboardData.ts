import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin (대시보드) 전용 server-only 데이터 레이어.
// 운영자 행동 중심: 카운트 + 조치가 필요한 short list + 활동 피드.
// 모든 쿼리는 read-only, 새 테이블/RPC 없음. canonical = public.user_profiles / applicants / user_edit_windows.

const RECENT_LIST_LIMIT = 5;
const EDIT_WINDOW_LIST_LIMIT = 10;
const EXPIRING_SOON_DAYS = 7;
const RECENT_UPDATE_DAYS = 7;

export type DashboardSummary = {
  totalMembers: number;
  pendingApplicants: number;
  openEditWindows: number;
  recentlyUpdatedMembers: number;
};

export type DashboardMember = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  authEmail: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type DashboardApplicant = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  createdAt: string | null;
};

export type DashboardEditWindow = {
  id: string;
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  resourceKey: string;
  openedAt: string;
  expiresAt: string;
};

export type DashboardSnapshot = {
  generatedAt: string;
  summary: DashboardSummary;
  actionNeeded: {
    pendingApplicants: DashboardApplicant[];
    membersWithoutOrganization: DashboardMember[];
    membersWithoutAuthEmail: DashboardMember[];
    expiringEditWindows: DashboardEditWindow[];
  };
  openEditWindows: DashboardEditWindow[];
  recent: {
    newMembers: DashboardMember[];
    recentlyUpdatedMembers: DashboardMember[];
    newApplicants: DashboardApplicant[];
  };
};

const MEMBER_SELECT =
  "user_id,display_name,organization_slug,auth_email,created_at,updated_at";

type MemberRow = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
  auth_email: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function toMember(row: MemberRow): DashboardMember {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    organizationSlug: row.organization_slug,
    authEmail: row.auth_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const APPLICANT_SELECT = "id,email,name,provider,created_at";

type ApplicantRow = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  created_at: string | null;
};

function toApplicant(row: ApplicantRow): DashboardApplicant {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    createdAt: row.created_at,
  };
}

const EDIT_WINDOW_SELECT =
  "id,user_id,resource_key,opened_at,expires_at";

type EditWindowRow = {
  id: string;
  user_id: string;
  resource_key: string;
  opened_at: string;
  expires_at: string;
};

// applicants 테이블이 신규 환경에 아직 없을 수 있어 friendly fallback 을 둔다.
// (lib/adminApplicantData.ts 와 동일한 휴리스틱)
function isMissingApplicantsTableError(error: { code?: string; message?: string } | null) {
  return Boolean(
    error &&
      (error.code === "PGRST205" ||
        error.message?.includes("public.applicants")),
  );
}

async function hydrateWindowsWithMembers(
  windows: EditWindowRow[],
): Promise<DashboardEditWindow[]> {
  if (windows.length === 0) return [];

  const userIds = Array.from(new Set(windows.map((w) => w.user_id)));
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", userIds);
  if (error) throw new Error(error.message);

  type ProfileMini = {
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  };
  const byId = new Map<string, ProfileMini>();
  for (const row of (data ?? []) as ProfileMini[]) {
    byId.set(row.user_id, row);
  }

  return windows.map((w) => {
    const profile = byId.get(w.user_id);
    return {
      id: w.id,
      userId: w.user_id,
      displayName: profile?.display_name ?? null,
      organizationSlug: profile?.organization_slug ?? null,
      resourceKey: w.resource_key,
      openedAt: w.opened_at,
      expiresAt: w.expires_at,
    };
  });
}

export async function loadDashboardSnapshot(
  now: Date = new Date(),
): Promise<DashboardSnapshot> {
  const nowIso = now.toISOString();
  const recentlyUpdatedSince = new Date(
    now.getTime() - RECENT_UPDATE_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const expiringBefore = new Date(
    now.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // 모두 head-only count 또는 좁은 select. 신경 쓸 만한 추가 round-trip 없음.
  const totalMembersP = supabaseAdmin
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true });

  const pendingApplicantsP = supabaseAdmin
    .from("applicants")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  const openEditWindowsCountP = supabaseAdmin
    .from("user_edit_windows")
    .select("id", { count: "exact", head: true })
    .lte("opened_at", nowIso)
    .gt("expires_at", nowIso);

  const recentlyUpdatedMembersCountP = supabaseAdmin
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true })
    .gte("updated_at", recentlyUpdatedSince);

  const pendingApplicantsListP = supabaseAdmin
    .from("applicants")
    .select(APPLICANT_SELECT)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(RECENT_LIST_LIMIT);

  const membersWithoutOrgP = supabaseAdmin
    .from("user_profiles")
    .select(MEMBER_SELECT)
    .is("organization_slug", null)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(RECENT_LIST_LIMIT);

  const membersWithoutAuthP = supabaseAdmin
    .from("user_profiles")
    .select(MEMBER_SELECT)
    .is("auth_email", null)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(RECENT_LIST_LIMIT);

  const expiringWindowsP = supabaseAdmin
    .from("user_edit_windows")
    .select(EDIT_WINDOW_SELECT)
    .gt("expires_at", nowIso)
    .lte("expires_at", expiringBefore)
    .order("expires_at", { ascending: true })
    .limit(EDIT_WINDOW_LIST_LIMIT);

  const openWindowsP = supabaseAdmin
    .from("user_edit_windows")
    .select(EDIT_WINDOW_SELECT)
    .lte("opened_at", nowIso)
    .gt("expires_at", nowIso)
    .order("expires_at", { ascending: true })
    .limit(EDIT_WINDOW_LIST_LIMIT);

  const newMembersP = supabaseAdmin
    .from("user_profiles")
    .select(MEMBER_SELECT)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(RECENT_LIST_LIMIT);

  const updatedMembersP = supabaseAdmin
    .from("user_profiles")
    .select(MEMBER_SELECT)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(RECENT_LIST_LIMIT);

  const newApplicantsP = supabaseAdmin
    .from("applicants")
    .select(APPLICANT_SELECT)
    .order("created_at", { ascending: false })
    .limit(RECENT_LIST_LIMIT);

  const [
    totalMembersR,
    pendingApplicantsR,
    openEditWindowsCountR,
    recentlyUpdatedMembersCountR,
    pendingApplicantsListR,
    membersWithoutOrgR,
    membersWithoutAuthR,
    expiringWindowsR,
    openWindowsR,
    newMembersR,
    updatedMembersR,
    newApplicantsR,
  ] = await Promise.all([
    totalMembersP,
    pendingApplicantsP,
    openEditWindowsCountP,
    recentlyUpdatedMembersCountP,
    pendingApplicantsListP,
    membersWithoutOrgP,
    membersWithoutAuthP,
    expiringWindowsP,
    openWindowsP,
    newMembersP,
    updatedMembersP,
    newApplicantsP,
  ]);

  // applicants 테이블이 없으면 0/[] 로 graceful degrade. 다른 에러는 throw.
  function applicantCount(
    result: typeof pendingApplicantsR,
  ): number {
    if (result.error) {
      if (isMissingApplicantsTableError(result.error)) return 0;
      throw new Error(result.error.message);
    }
    return result.count ?? 0;
  }

  function applicantList(
    result: typeof pendingApplicantsListR,
  ): DashboardApplicant[] {
    if (result.error) {
      if (isMissingApplicantsTableError(result.error)) return [];
      throw new Error(result.error.message);
    }
    return ((result.data ?? []) as unknown as ApplicantRow[]).map(toApplicant);
  }

  function memberCount(result: typeof totalMembersR): number {
    if (result.error) throw new Error(result.error.message);
    return result.count ?? 0;
  }

  function memberList(result: typeof membersWithoutOrgR): DashboardMember[] {
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as unknown as MemberRow[]).map(toMember);
  }

  function windowRows(result: typeof openWindowsR): EditWindowRow[] {
    if (result.error) throw new Error(result.error.message);
    return ((result.data ?? []) as unknown as EditWindowRow[]);
  }

  function windowCount(result: typeof openEditWindowsCountR): number {
    if (result.error) throw new Error(result.error.message);
    return result.count ?? 0;
  }

  const [openWindowsHydrated, expiringWindowsHydrated] = await Promise.all([
    hydrateWindowsWithMembers(windowRows(openWindowsR)),
    hydrateWindowsWithMembers(windowRows(expiringWindowsR)),
  ]);

  return {
    generatedAt: nowIso,
    summary: {
      totalMembers: memberCount(totalMembersR),
      pendingApplicants: applicantCount(pendingApplicantsR),
      openEditWindows: windowCount(openEditWindowsCountR),
      recentlyUpdatedMembers: memberCount(recentlyUpdatedMembersCountR),
    },
    actionNeeded: {
      pendingApplicants: applicantList(pendingApplicantsListR),
      membersWithoutOrganization: memberList(membersWithoutOrgR),
      membersWithoutAuthEmail: memberList(membersWithoutAuthR),
      expiringEditWindows: expiringWindowsHydrated,
    },
    openEditWindows: openWindowsHydrated,
    recent: {
      newMembers: memberList(newMembersR),
      recentlyUpdatedMembers: memberList(updatedMembersR),
      newApplicants: applicantList(newApplicantsR),
    },
  };
}
