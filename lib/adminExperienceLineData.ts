import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  ExperienceLineMasterDto,
  ExperienceLineMasterCreateInput,
  ExperienceLineMasterPatchInput,
  CrewItemDto,
} from "@/lib/adminExperienceLineTypes";

// ── Experience Line Masters ─────────────────────────────────

type MasterRow = {
  id: string;
  organization_slug: string;
  line_code: string;
  line_name: string;
  default_main_title: string | null;
  team_id: string | null;
  source_file_name: string | null;
  is_active: boolean;
  // 5슬롯 분류 (마이그레이션 적용 전 환경에서는 select '*' 에 없을 수 있어 optional).
  experience_category?: ExperienceLineMasterDto["experienceCategory"];
  experience_slot_order?: number | null;
  created_at: string;
  updated_at: string;
  cluster4_teams: { team_name: string } | null;
};

function toMasterDto(row: MasterRow): ExperienceLineMasterDto {
  return {
    id: row.id,
    organizationSlug: row.organization_slug,
    lineCode: row.line_code,
    lineName: row.line_name,
    mainTitle: row.default_main_title,
    teamId: row.team_id,
    teamName: row.cluster4_teams?.team_name ?? null,
    sourceFileName: row.source_file_name,
    isActive: row.is_active,
    experienceCategory: row.experience_category ?? null,
    experienceSlotOrder: row.experience_slot_order ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listExperienceLineMasters(
  organizationSlug?: string | null,
): Promise<{ rows: ExperienceLineMasterDto[] }> {
  let query = supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("*,cluster4_teams(team_name)")
    .order("line_code", { ascending: true });

  if (organizationSlug) {
    query = query.eq("organization_slug", organizationSlug);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return { rows: ((data ?? []) as unknown as MasterRow[]).map(toMasterDto) };
}

export async function getExperienceLineMaster(
  id: string,
): Promise<ExperienceLineMasterDto | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("*,cluster4_teams(team_name)")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return toMasterDto(data as unknown as MasterRow);
}

export async function createExperienceLineMaster(
  input: ExperienceLineMasterCreateInput,
): Promise<ExperienceLineMasterDto> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .insert({
      organization_slug: input.organizationSlug,
      line_code: input.lineCode,
      line_name: input.lineName,
      default_main_title: input.mainTitle,
      team_id: input.teamId,
      source_file_name: input.sourceFileName,
      is_active: input.isActive,
    })
    .select("*,cluster4_teams(team_name)")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("이미 존재하는 라인 코드입니다"), { status: 409 });
    }
    throw new Error(error.message);
  }
  return toMasterDto(data as unknown as MasterRow);
}

export async function patchExperienceLineMaster(
  id: string,
  input: ExperienceLineMasterPatchInput,
): Promise<ExperienceLineMasterDto> {
  const patch: Record<string, unknown> = {};
  if (input.organizationSlug !== undefined) patch.organization_slug = input.organizationSlug;
  if (input.lineCode !== undefined) patch.line_code = input.lineCode;
  if (input.lineName !== undefined) patch.line_name = input.lineName;
  if (input.mainTitle !== undefined) patch.default_main_title = input.mainTitle;
  if (input.teamId !== undefined) patch.team_id = input.teamId;
  if (input.sourceFileName !== undefined) patch.source_file_name = input.sourceFileName;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .update(patch)
    .eq("id", id)
    .select("*,cluster4_teams(team_name)")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("이미 존재하는 라인 코드입니다"), { status: 409 });
    }
    throw new Error(error.message);
  }
  return toMasterDto(data as unknown as MasterRow);
}

export async function deleteExperienceLineMaster(id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);
}

// ── Teams ───────────────────────────────────────────────────

export type TeamDto = {
  id: string;
  teamName: string;
  organizationSlug: string;
  isActive: boolean;
};

export async function listTeams(
  organizationSlug?: string | null,
): Promise<TeamDto[]> {
  let query = supabaseAdmin
    .from("cluster4_teams")
    .select("id,team_name,organization_slug,is_active")
    .eq("is_active", true)
    .order("team_name", { ascending: true });

  if (organizationSlug) {
    query = query.eq("organization_slug", organizationSlug);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<{
    id: string;
    team_name: string;
    organization_slug: string;
    is_active: boolean;
  }>).map((r) => ({
    id: r.id,
    teamName: r.team_name,
    organizationSlug: r.organization_slug,
    isActive: r.is_active,
  }));
}

// ── Crews (enriched for target selection) ───────────────────

type ProfileRow = {
  user_id: string;
  display_name: string | null;
  profile_photo_url: string | null;
  organization_slug: string | null;
};

type MembershipRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  membership_state: string | null;
  is_current: boolean | null;
};

export async function listCrewsForTargetSelection(options: {
  organization?: string | null;
  team?: string | null;
  part?: string | null;
  membershipLevel?: string | null;
  status?: string | null;
  search?: string | null;
}): Promise<CrewItemDto[]> {
  let profileQuery = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,profile_photo_url,organization_slug")
    .order("display_name", { ascending: true });

  if (options.organization) {
    profileQuery = profileQuery.eq("organization_slug", options.organization);
  }

  if (options.search) {
    profileQuery = profileQuery.ilike("display_name", `%${options.search}%`);
  }

  const { data: profiles, error: profileError } = await profileQuery;
  if (profileError) throw new Error(profileError.message);
  if (!profiles || profiles.length === 0) return [];

  const userIds = (profiles as ProfileRow[]).map((p) => p.user_id);

  const { data: memberships, error: memError } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,membership_level,membership_state,is_current")
    .in("user_id", userIds);

  if (memError) throw new Error(memError.message);

  const memMap = new Map<string, MembershipRow>();
  for (const m of (memberships ?? []) as MembershipRow[]) {
    const existing = memMap.get(m.user_id);
    if (!existing || (m.is_current && !existing.is_current)) {
      memMap.set(m.user_id, m);
    }
  }

  let result: CrewItemDto[] = (profiles as ProfileRow[]).map((p) => {
    const m = memMap.get(p.user_id);
    return {
      userId: p.user_id,
      displayName: p.display_name ?? "(이름 없음)",
      profileImg: p.profile_photo_url,
      organization: p.organization_slug,
      teamName: m?.team_name ?? null,
      partName: m?.part_name ?? null,
      membershipLevel: m?.membership_level ?? null,
      membershipState: m?.membership_state ?? null,
    };
  });

  if (options.team) {
    result = result.filter((c) => c.teamName === options.team);
  }
  if (options.part) {
    result = result.filter((c) => c.partName === options.part);
  }
  if (options.membershipLevel) {
    result = result.filter((c) => c.membershipLevel === options.membershipLevel);
  }
  if (options.status) {
    const isActive = options.status === "active";
    result = result.filter((c) =>
      isActive
        ? c.membershipState !== "rest"
        : c.membershipState === "rest",
    );
  }

  return result;
}

// ── Admin Organization ──────────────────────────────────────

export async function getAdminOrganization(
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("organization_slug")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) return null;
  return (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
}
