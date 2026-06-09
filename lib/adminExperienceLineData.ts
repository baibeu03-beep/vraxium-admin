import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchCrewNoMap } from "@/lib/adminCrewNo";
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

// (2E-6) 개설 드롭다운 목록 — line_registrations 기준 전환.
//   - 행 집합 = bridged registration (hub='experience'). id 는 bridged_master_id 를 그대로
//     노출해 기존 개설 POST 의 master FK 기록 체계를 유지한다.
//   - 필드 SoT = registration (name/code/title/org/active/종류→category·slot).
//     registration 에 없는 레거시 필드(teamId/teamName/sourceFileName/created/updated)는
//     read-mirror 마스터에서 보강 — DTO shape/값 등가 (양방향 sync 가 정합 보장).
//   - fallback: registrations 조회 실패 시 기존 마스터 직조로 복귀 (운영 중단 방지).
export async function listExperienceLineMasters(
  organizationSlug?: string | null,
): Promise<{ rows: ExperienceLineMasterDto[] }> {
  const KO_PAIR: Record<string, { category: string; slot: number }> = {
    도출: { category: "derivation", slot: 1 },
    분석: { category: "analysis", slot: 2 },
    평가: { category: "evaluation", slot: 3 },
    확장: { category: "extension", slot: 4 },
    관리: { category: "management", slot: 5 },
  };

  let regQuery = supabaseAdmin
    .from("line_registrations")
    .select(
      "line_code,line_name,line_type,main_title,main_title_mode,organization_slug,is_active,bridged_master_id",
    )
    .eq("hub", "experience")
    .not("bridged_master_id", "is", null)
    .order("line_code", { ascending: true });
  if (organizationSlug) {
    regQuery = regQuery.eq("organization_slug", organizationSlug);
  }
  const { data: regs, error: regError } = await regQuery;

  if (!regError) {
    type RegRow = {
      line_code: string;
      line_name: string;
      line_type: string;
      main_title: string;
      main_title_mode: string;
      organization_slug: string | null;
      is_active: boolean;
      bridged_master_id: string;
    };
    const regRows = (regs ?? []) as RegRow[];
    // 레거시 필드 보강 — read-mirror 마스터 batch 조회.
    const masterIds = regRows.map((r) => r.bridged_master_id);
    const legacyById = new Map<
      string,
      {
        team_id: string | null;
        team_name: string | null;
        source_file_name: string | null;
        created_at: string;
        updated_at: string;
      }
    >();
    if (masterIds.length > 0) {
      const { data: masters, error: masterError } = await supabaseAdmin
        .from("cluster4_experience_line_masters")
        .select("id,team_id,source_file_name,created_at,updated_at,cluster4_teams(team_name)")
        .in("id", masterIds);
      if (masterError) {
        console.warn("[2E-6 exp 목록] mirror 보강 조회 실패", { message: masterError.message });
      } else {
        for (const m of (masters ?? []) as unknown as Array<{
          id: string;
          team_id: string | null;
          source_file_name: string | null;
          created_at: string;
          updated_at: string;
          cluster4_teams: { team_name: string } | null;
        }>) {
          legacyById.set(m.id, {
            team_id: m.team_id,
            team_name: m.cluster4_teams?.team_name ?? null,
            source_file_name: m.source_file_name,
            created_at: m.created_at,
            updated_at: m.updated_at,
          });
        }
      }
    }
    const rows: ExperienceLineMasterDto[] = regRows.map((r) => {
      const legacy = legacyById.get(r.bridged_master_id) ?? null;
      const pair = KO_PAIR[r.line_type] ?? null;
      return {
        id: r.bridged_master_id,
        organizationSlug: r.organization_slug ?? "",
        lineCode: r.line_code,
        lineName: r.line_name,
        mainTitle: r.main_title_mode === "fixed" && r.main_title.trim() ? r.main_title : null,
        teamId: legacy?.team_id ?? null,
        teamName: legacy?.team_name ?? null,
        sourceFileName: legacy?.source_file_name ?? null,
        isActive: r.is_active,
        experienceCategory:
          (pair?.category as ExperienceLineMasterDto["experienceCategory"]) ?? null,
        experienceSlotOrder: pair?.slot ?? null,
        createdAt: legacy?.created_at ?? "",
        updatedAt: legacy?.updated_at ?? "",
      };
    });
    return { rows };
  }

  console.warn("[2E-6 exp 목록] registrations 조회 실패 — 마스터 fallback", {
    message: regError.message,
  });
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

  // 운영용 크루 번호 — best-effort(컬럼 미존재 시 빈 맵). 기존 select 무변경.
  const crewNoMap = await fetchCrewNoMap(userIds);

  let result: CrewItemDto[] = (profiles as ProfileRow[]).map((p) => {
    const m = memMap.get(p.user_id);
    return {
      userId: p.user_id,
      displayName: p.display_name ?? "(이름 없음)",
      crewNo: crewNoMap.get(p.user_id) ?? null,
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
