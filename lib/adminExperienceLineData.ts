import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  selectRegistrationsWithDuration,
  toLineDurationDto,
} from "@/lib/adminLineRegistrationsData";
import { fetchCrewNoMap } from "@/lib/adminCrewNo";
import {
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import { filterTeamsByScope } from "@/lib/cluster4ExperienceTestScope";
import type {
  ExperienceLineMasterDto,
  ExperienceLineMasterCreateInput,
  ExperienceLineMasterPatchInput,
  CrewItemDto,
} from "@/lib/adminExperienceLineTypes";
import type {
  PartInputLineOption,
  PartInputLineOptions,
} from "@/lib/experiencePartInputTypes";
import type {
  ExperienceOverallCategory,
  OverallLineOptions,
} from "@/lib/experienceTeamOverallTypes";

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
    // 레거시 마스터 테이블에는 소요 시간 컬럼이 없다 — fallback 경로는 항상 미설정(null → '-').
    estimatedDurationMinutes: null,
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

  // 소요 시간은 registrations 에서 함께 읽는다. 컬럼이 없는 환경(마이그 전)에서도 레거시 마스터
  //   fallback 으로 떨어지지 않도록 selectRegistrationsWithDuration 이 컬럼만 빼고 재시도한다.
  const EXP_REG_SELECT =
    "line_code,line_name,line_type,main_title,main_title_mode,organization_slug,is_active,bridged_master_id";
  const { data: regs, error: regError } = await selectRegistrationsWithDuration(
    (selectStr) => {
      let q = supabaseAdmin
        .from("line_registrations")
        .select(selectStr)
        .eq("hub", "experience")
        .not("bridged_master_id", "is", null)
        .order("line_code", { ascending: true });
      if (organizationSlug) {
        q = q.eq("organization_slug", organizationSlug);
      }
      return q;
    },
    EXP_REG_SELECT,
  );

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
      estimated_duration_minutes?: number | null;
    };
    // select 문자열이 동적이라 supabase-js 가 행 타입을 추론하지 못한다(adminLineRegistrationsData 와 동일 관례).
    const regRows = (regs ?? []) as unknown as RegRow[];
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
        estimatedDurationMinutes: toLineDurationDto(r.estimated_duration_minutes),
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

// ── 라인명 드롭다운 옵션(유형별) — 개설 신청/검수/서버 검증 공용 단일 원천 ─────────
// /admin/lines/register 원장(line_registrations, hub=experience)에서 유형이 일치하는
// 활성 라인만 5카테고리(도출/분석/견문/확장/관리)별로 그룹핑한다. value=bridged_master_id.
//   · org 전용 + 공통(org NULL) 둘 다 포함(개설 완료 loadRegLinesByCategory 와 동일 스코프).
//   · 화면 텍스트가 아닌 실제 line_type 코드로 매칭(요구사항 §2).
//   · 반환 구조/필드는 org·mode 무관 동일(모든 경로가 이 함수만 사용 → DTO 이원화 금지).
const KO_LINE_TYPE_TO_CATEGORY: Record<string, ExperienceOverallCategory> = {
  도출: "derivation",
  분석: "analysis",
  평가: "evaluation", // 표시 라벨은 '견문'. 원장 line_type 코드는 '평가'.
  확장: "extension",
  관리: "management",
};

// 5카테고리 전체 옵션 로드(내부 공용).
async function loadExperienceLineOptionsAllCategories(
  organizationSlug?: string | null,
): Promise<OverallLineOptions> {
  const out: OverallLineOptions = {
    derivation: [],
    analysis: [],
    evaluation: [],
    extension: [],
    management: [],
  };

  let query = supabaseAdmin
    .from("line_registrations")
    .select("line_code,line_name,line_type,organization_slug,is_active,bridged_master_id")
    .eq("hub", "experience")
    .eq("is_active", true)
    .not("bridged_master_id", "is", null)
    .order("line_code", { ascending: true });
  query = organizationSlug
    ? query.or(`organization_slug.is.null,organization_slug.eq.${organizationSlug}`)
    : query.is("organization_slug", null);

  const { data, error } = await query;
  if (error) {
    console.warn("[experience line-options] registrations 조회 실패", error.message);
    return out;
  }

  const seen = new Set<string>(); // (category::id) 중복 방지(org+공통 중복 라인).
  for (const r of (data ?? []) as Array<{
    line_code: string;
    line_name: string;
    line_type: string;
    bridged_master_id: string;
  }>) {
    const category = KO_LINE_TYPE_TO_CATEGORY[r.line_type];
    if (!category) continue;
    const key = `${category}::${r.bridged_master_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[category].push({
      id: r.bridged_master_id,
      lineName: r.line_name,
      lineCode: r.line_code,
    });
  }
  return out;
}

// 개설 신청 그리드용 3카테고리(도출/분석/견문).
export async function listExperienceLineOptions(
  organizationSlug?: string | null,
): Promise<PartInputLineOptions> {
  const all = await loadExperienceLineOptionsAllCategories(organizationSlug);
  return {
    derivation: all.derivation,
    analysis: all.analysis,
    evaluation: all.evaluation,
  };
}

// 팀 총괄(검수/완료)용 5카테고리(도출/분석/견문/확장/관리).
export async function listExperienceOverallLineOptions(
  organizationSlug?: string | null,
): Promise<OverallLineOptions> {
  return loadExperienceLineOptionsAllCategories(organizationSlug);
}

// 옵션 → (id → category) 맵. 서버 저장 시 "선택 라인 유형 == 셀 카테고리" 검증에 쓴다.
//   제네릭 — 3카테고리(part) / 5카테고리(overall) 공용.
export function buildLineIdCategoryMap<K extends string>(
  options: Record<K, PartInputLineOption[]>,
): Map<string, K> {
  const map = new Map<string, K>();
  (Object.keys(options) as K[]).forEach((category) => {
    for (const opt of options[category]) map.set(opt.id, category);
  });
  return map;
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

// 팀 목록 canonical 산출 경로. 팀 스코프(operating=운영 팀만 / test=(T) 테스트 팀만)는
// filterTeamsByScope 단일 helper 로 적용한다(화면별 임시 필터 금지). mode 기본=operating.
export async function listTeams(
  organizationSlug?: string | null,
  mode: ScopeMode = "operating",
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

  const teams = ((data ?? []) as Array<{
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

  return filterTeamsByScope(teams, organizationSlug ?? null, mode);
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
  mode?: ScopeMode;
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

  // 모집단 스코프 — userScope resolver(SoT). QA_HIDE_REAL_USERS=true 면 mode 무관 test 모집단(화면=write 대상).
  const scope = await resolveUserScope(options.mode ?? "operating", null);
  const scopedProfiles = (profiles as ProfileRow[]).filter((p) => scope.includes(p.user_id));
  if (scopedProfiles.length === 0) return [];

  const userIds = scopedProfiles.map((p) => p.user_id);

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

  let result: CrewItemDto[] = scopedProfiles.map((p) => {
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
