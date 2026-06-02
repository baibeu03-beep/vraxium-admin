import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { SUPER_ADMIN_EXCLUDE_OR } from "@/lib/superAdmins";
import {
  isMemberAssignableRole,
  MEMBER_ASSIGNABLE_ROLES,
  MEMBER_PATCH_FIELDS,
  ORG_NONE_SENTINEL,
  PART_UNIQUE_ROLES,
  TEAM_UNIQUE_ROLES,
  type AdminMemberDto,
  type ListMembersOptions,
  type ListMembersResult,
  type MemberAssignableRole,
  type MemberPatchField,
  type MemberSortColumn,
  type MemberSortDir,
} from "@/lib/adminMembersTypes";

// /admin/members 전용 데이터 레이어 (server-only).
// canonical source = public.user_profiles. legacy import 무관, user_id(UUID) 기준.
// 브라우저 안전한 상수/타입은 lib/adminMembersTypes.ts 에 분리되어 있다.

export {
  MEMBER_ASSIGNABLE_ROLES,
  MEMBER_PATCH_FIELDS,
  ORG_NONE_SENTINEL,
  type AdminMemberDto,
  type ListMembersOptions,
  type ListMembersResult,
  type MemberAssignableRole,
  type MemberPatchField,
  type MemberSortColumn,
  type MemberSortDir,
};

const MEMBER_SELECT = [
  "user_id",
  "display_name",
  "contact_email",
  "contact_phone",
  "auth_email",
  "organization_slug",
  "status",
  "growth_status",
  "role",
  "current_team_name",
  "current_part_name",
  "created_at",
  "updated_at",
].join(",");

type MemberRow = {
  user_id: string;
  display_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  auth_email: string | null;
  organization_slug: string | null;
  status: string | null;
  growth_status: string | null;
  role: string | null;
  current_team_name: string | null;
  current_part_name: string | null;
  created_at: string | null;
  updated_at: string | null;
};

function toDto(row: MemberRow): AdminMemberDto {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    authEmail: row.auth_email,
    organizationSlug: row.organization_slug,
    status: row.status,
    growthStatus: row.growth_status,
    role: row.role,
    currentTeamName: row.current_team_name,
    currentPartName: row.current_part_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

// 검색어 + 상태/성장 필터 등 "선택적 조건"만 적용한다.
// organization, auth_email, contact_email 의 presence 필터는 caller 에서 조합한다.
type FilterFlags = {
  applyOrganization?: boolean;
  applyAuthEmailPresence?: boolean;
  applyContactEmailPresence?: boolean;
};

function applyFilters<T extends { eq: unknown; is: unknown; or: unknown }>(
  builder: T,
  options: ListMembersOptions,
  flags: FilterFlags,
): T {
  let q = builder as unknown as {
    eq: (col: string, value: string) => typeof q;
    is: (col: string, value: null) => typeof q;
    not: (col: string, op: string, value: null) => typeof q;
    or: (filters: string) => typeof q;
  };

  // super admin 은 멤버 목록/카운트 전부에서 제외 (목록 노출에서만 숨김, 인가와 무관).
  q = q.or(SUPER_ADMIN_EXCLUDE_OR);

  if (flags.applyOrganization && options.organization) {
    if (options.organization === ORG_NONE_SENTINEL) {
      q = q.is("organization_slug", null);
    } else {
      q = q.eq("organization_slug", options.organization);
    }
  }

  if (options.status) {
    q = q.eq("status", options.status);
  }

  if (options.growthStatus) {
    q = q.eq("growth_status", options.growthStatus);
  }

  if (flags.applyAuthEmailPresence && options.authEmailPresence) {
    if (options.authEmailPresence === "missing") {
      q = q.is("auth_email", null);
    } else {
      q = q.not("auth_email", "is", null);
    }
  }

  if (flags.applyContactEmailPresence && options.contactEmailPresence) {
    if (options.contactEmailPresence === "missing") {
      q = q.is("contact_email", null);
    } else {
      q = q.not("contact_email", "is", null);
    }
  }

  const rawQuery = options.query?.trim() ?? "";
  const trimmed = rawQuery ? escapeForIlike(rawQuery) : "";
  const filters = [
    ...(trimmed
      ? [
          `display_name.ilike.%${trimmed}%`,
          `contact_email.ilike.%${trimmed}%`,
          `auth_email.ilike.%${trimmed}%`,
        ]
      : []),
    // user_id 는 UUID 컬럼이라 ilike 가 불가. 완전 일치만 허용.
    ...(isUuid(rawQuery) ? [`user_id.eq.${rawQuery}`] : []),
  ];

  if (filters.length > 0) {
    q = q.or(filters.join(","));
  }

  return q as unknown as T;
}

export async function listMembers(
  options: ListMembersOptions = {},
): Promise<ListMembersResult> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const sortBy: MemberSortColumn = options.sortBy ?? "created_at";
  const sortDir: MemberSortDir = options.sortDir ?? "desc";

  let queryBuilder = supabaseAdmin
    .from("user_profiles")
    .select(MEMBER_SELECT, { count: "exact" });

  queryBuilder = applyFilters(queryBuilder, options, {
    applyOrganization: true,
    applyAuthEmailPresence: true,
    applyContactEmailPresence: true,
  });

  queryBuilder = queryBuilder
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .order("user_id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) throw new Error(error.message);

  // 요약 카운트 — 각 카운트는 해당 컬럼 필터를 제외한 동일 검색 조건으로 집계한다.
  // 운영자가 "지금 조건에서 소속 없음 N명" 처럼 안내받기 위함.
  let withoutOrgBuilder = supabaseAdmin
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true });
  withoutOrgBuilder = applyFilters(withoutOrgBuilder, options, {
    applyOrganization: false,
    applyAuthEmailPresence: true,
    applyContactEmailPresence: true,
  });
  withoutOrgBuilder = withoutOrgBuilder.is("organization_slug", null);

  let withoutAuthBuilder = supabaseAdmin
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true });
  withoutAuthBuilder = applyFilters(withoutAuthBuilder, options, {
    applyOrganization: true,
    applyAuthEmailPresence: false,
    applyContactEmailPresence: true,
  });
  withoutAuthBuilder = withoutAuthBuilder.is("auth_email", null);

  const [withoutOrgResult, withoutAuthResult] = await Promise.all([
    withoutOrgBuilder,
    withoutAuthBuilder,
  ]);

  if (withoutOrgResult.error) throw new Error(withoutOrgResult.error.message);
  if (withoutAuthResult.error) throw new Error(withoutAuthResult.error.message);

  return {
    members: ((data ?? []) as unknown as MemberRow[]).map(toDto),
    total: count ?? 0,
    withoutOrganizationCount: withoutOrgResult.count ?? 0,
    withoutAuthEmailCount: withoutAuthResult.count ?? 0,
    limit,
    offset,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// PATCH — 한 멤버의 일부 필드만 수정.
// auth_email, user_id, display_name 등은 whitelist 에 포함하지 않는다.
// ─────────────────────────────────────────────────────────────────────────

export class MemberPatchError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MemberPatchError";
    this.status = status;
  }
}

export type MemberPatchInput = Partial<{
  organization_slug: string | null;
  status: string | null;
  growth_status: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  // role 은 enum(4종) 검증을 거치므로 nullable-string 화이트리스트와 별도로 다룬다.
  role: MemberAssignableRole;
}>;

function coerceNullableString(
  raw: unknown,
  field: MemberPatchField,
): string | null {
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new MemberPatchError(400, `${field} must be a string or null`);
  }
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

export function pickMemberPatch(body: unknown): MemberPatchInput {
  if (!body || typeof body !== "object") {
    throw new MemberPatchError(400, "Request body must be a JSON object");
  }
  const input = body as Record<string, unknown>;
  const patch: MemberPatchInput = {};
  for (const key of MEMBER_PATCH_FIELDS) {
    if (!(key in input)) continue;
    patch[key] = coerceNullableString(input[key], key);
  }
  // role 은 4종 enum 만 허용. null/미지정은 허용하지 않는다(역할은 항상 1개).
  if ("role" in input) {
    const raw = input.role;
    if (!isMemberAssignableRole(raw)) {
      throw new MemberPatchError(
        400,
        `role must be one of: ${MEMBER_ASSIGNABLE_ROLES.join(", ")}`,
      );
    }
    patch.role = raw;
  }
  if (Object.keys(patch).length === 0) {
    throw new MemberPatchError(400, "No editable fields provided");
  }
  return patch;
}

// ─────────────────────────────────────────────────────────────────────────
// 유일성 검증.
//   - team_leader : 같은 (org, current_team_name) 에 1명
//   - agent / part_leader : 같은 (org, current_team_name, current_part_name) 에 1명
//     (part_name 이 팀별로 재사용되므로 팀 + 파트를 함께 봐야 한다 →
//      2026-06-01_member_roles_part_scope_fix.sql 의 부분 유니크 인덱스와 일치)
// role 은 user_profiles, 팀/파트는 비정규화된 current_* 를 사용한다.
// DB 의 부분 유니크 인덱스가 최종 방어선이고, 이 함수는 친절한 한국어 409 를 위한 1차 검증.
// ─────────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<MemberAssignableRole, string> = {
  crew: "크루",
  agent: "에이전트",
  part_leader: "파트장",
  team_leader: "팀장",
};

async function assertRoleUniqueness(
  userId: string,
  role: MemberAssignableRole,
  org: string | null,
  currentTeamName: string | null,
  currentPartName: string | null,
): Promise<void> {
  const isPartUnique = (PART_UNIQUE_ROLES as readonly string[]).includes(role);
  const isTeamUnique = (TEAM_UNIQUE_ROLES as readonly string[]).includes(role);
  if (!isPartUnique && !isTeamUnique) return; // crew 등은 제한 없음

  // 비교 축이 비어 있으면 유일성 강제 불가 → 통과시킨다.
  // (NULL 은 부분 유니크 인덱스에서도 충돌하지 않으므로 일관된 동작.)
  //   team_leader        → current_team_name 필요
  //   agent/part_leader  → current_team_name + current_part_name 모두 필요
  if (!currentTeamName) return;
  if (isPartUnique && !currentPartName) return;

  let query = supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("role", role)
    .eq("current_team_name", currentTeamName)
    .neq("user_id", userId);

  if (isPartUnique) {
    query = query.eq("current_part_name", currentPartName as string);
  }

  query = org === null ? query.is("organization_slug", null) : query.eq("organization_slug", org);

  const { data, error } = await query.limit(1);
  if (error) {
    throw new MemberPatchError(500, `유일성 검증 실패: ${error.message}`);
  }
  if (data && data.length > 0) {
    const scopeLabel = isTeamUnique
      ? `팀(${currentTeamName})`
      : `파트(${currentTeamName} / ${currentPartName})`;
    throw new MemberPatchError(
      409,
      `해당 ${scopeLabel}에는 이미 ${ROLE_LABEL[role]} 역할의 멤버가 있습니다. 한 ${isTeamUnique ? "팀" : "파트"}에는 ${ROLE_LABEL[role]}이 최대 1명만 가능합니다.`,
    );
  }
}

export async function updateMember(
  userId: string,
  patch: MemberPatchInput,
  actorId?: string | null,
): Promise<AdminMemberDto> {
  if (!isUuid(userId)) {
    throw new MemberPatchError(400, "user_id must be a UUID");
  }

  // role 변경 시: 현재 행을 먼저 읽어 (이전 role / 현재 소속 / org) 를 확보하고
  // 유일성을 사전 검증한다. (org 가 동시에 바뀌면 새 org 기준으로 검증.)
  let oldRole: string | null = null;
  if (patch.role !== undefined) {
    const { data: current, error: readError } = await supabaseAdmin
      .from("user_profiles")
      .select("role,organization_slug,current_team_name,current_part_name")
      .eq("user_id", userId)
      .single();

    if (readError || !current) {
      if (readError?.code === "PGRST116") {
        throw new MemberPatchError(404, "user_profile not found");
      }
      throw new MemberPatchError(
        500,
        readError?.message ?? "Failed to read user_profile",
      );
    }

    oldRole = (current.role as string | null) ?? null;
    const effectiveOrg =
      patch.organization_slug !== undefined
        ? patch.organization_slug
        : ((current.organization_slug as string | null) ?? null);

    await assertRoleUniqueness(
      userId,
      patch.role,
      effectiveOrg,
      (current.current_team_name as string | null) ?? null,
      (current.current_part_name as string | null) ?? null,
    );
  }

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .update(patch)
    .eq("user_id", userId)
    .select(MEMBER_SELECT)
    .single();

  if (error || !data) {
    if (error?.code === "PGRST116") {
      throw new MemberPatchError(404, "user_profile not found");
    }
    // 부분 유니크 인덱스 위반 — 동시성/외부 경로로 검증을 빠져나간 경우의 최종 방어.
    if (error?.code === "23505") {
      throw new MemberPatchError(
        409,
        "같은 파트/팀에 동일 역할 멤버가 이미 존재합니다(유일성 제약 위반).",
      );
    }
    throw new MemberPatchError(500, error?.message ?? "Failed to update user_profile");
  }

  const dto = toDto(data as unknown as MemberRow);

  // 역할이 실제로 바뀐 경우만 감사 로그 (best-effort — 실패해도 저장은 성공 처리).
  if (patch.role !== undefined && actorId && dto.role !== oldRole) {
    const { error: auditError } = await supabaseAdmin
      .from("user_role_audit")
      .insert({
        user_id: userId,
        old_role: oldRole,
        new_role: dto.role,
        changed_by: actorId,
        reason: "updated via /admin/members",
      });
    if (auditError) {
      console.error("[updateMember] role audit insert failed", {
        userId,
        oldRole,
        newRole: dto.role,
        error: auditError.message,
      });
    }
  }

  return dto;
}
