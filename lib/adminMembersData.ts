import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  MEMBER_PATCH_FIELDS,
  ORG_NONE_SENTINEL,
  type AdminMemberDto,
  type ListMembersOptions,
  type ListMembersResult,
  type MemberPatchField,
  type MemberSortColumn,
  type MemberSortDir,
} from "@/lib/adminMembersTypes";

// /admin/members 전용 데이터 레이어 (server-only).
// canonical source = public.user_profiles. legacy import 무관, user_id(UUID) 기준.
// 브라우저 안전한 상수/타입은 lib/adminMembersTypes.ts 에 분리되어 있다.

export {
  MEMBER_PATCH_FIELDS,
  ORG_NONE_SENTINEL,
  type AdminMemberDto,
  type ListMembersOptions,
  type ListMembersResult,
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
  if (Object.keys(patch).length === 0) {
    throw new MemberPatchError(400, "No editable fields provided");
  }
  return patch;
}

export async function updateMember(
  userId: string,
  patch: MemberPatchInput,
): Promise<AdminMemberDto> {
  if (!isUuid(userId)) {
    throw new MemberPatchError(400, "user_id must be a UUID");
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
    throw new MemberPatchError(500, error?.message ?? "Failed to update user_profile");
  }

  return toDto(data as unknown as MemberRow);
}
