import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  isEditableResourceKey,
  type EditWindowDto,
  type EditWindowUserRow,
  type ListEditWindowsResult,
} from "@/lib/adminEditWindowsTypes";

// /admin/settings/edit-windows 전용 server-only 데이터 레이어.
// canonical 테이블: public.user_edit_windows (resource_key 단위 unique by user_id).

export class EditWindowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EditWindowError";
    this.status = status;
  }
}

type EditWindowRow = {
  id: string;
  user_id: string;
  resource_key: string;
  opened_at: string;
  expires_at: string;
  granted_by: string | null;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  contact_email: string | null;
  organization_slug: string | null;
};

const WINDOW_SELECT =
  "id,user_id,resource_key,opened_at,expires_at,granted_by,note,created_at,updated_at";

const PROFILE_SELECT =
  "user_id,display_name,auth_email,contact_email,organization_slug";

function toDto(row: EditWindowRow): EditWindowDto {
  return {
    id: row.id,
    userId: row.user_id,
    resourceKey: row.resource_key,
    openedAt: row.opened_at,
    expiresAt: row.expires_at,
    grantedBy: row.granted_by,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

// ─────────────────────────────────────────────────────────────────────────
// LIST: 검색어 + resource_key 로 사용자 목록을 가져오면서, 같은 resource_key 의
// edit-window 가 있으면 같이 붙여 반환한다. window 가 없는 사용자도 함께 노출되어
// 관리자가 "권한 없음 → 새로 부여" 흐름을 그대로 수행할 수 있다.
// ─────────────────────────────────────────────────────────────────────────

export type ListEditWindowsOptions = {
  query?: string | null;
  resourceKey: string;
  limit?: number;
  offset?: number;
};

export async function listEditWindowsWithUsers(
  options: ListEditWindowsOptions,
): Promise<ListEditWindowsResult> {
  if (!isEditableResourceKey(options.resourceKey)) {
    throw new EditWindowError(
      400,
      `Unknown resource_key: ${options.resourceKey}`,
    );
  }

  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let queryBuilder = supabaseAdmin
    .from("user_profiles")
    .select(PROFILE_SELECT, { count: "exact" });

  const rawQuery = options.query?.trim() ?? "";
  const trimmed = rawQuery ? escapeForIlike(rawQuery) : "";
  const filters = [
    ...(trimmed
      ? [
          `display_name.ilike.%${trimmed}%`,
          `auth_email.ilike.%${trimmed}%`,
          `contact_email.ilike.%${trimmed}%`,
          `organization_slug.ilike.%${trimmed}%`,
        ]
      : []),
    ...(isUuid(rawQuery) ? [`user_id.eq.${rawQuery}`] : []),
  ];
  if (filters.length > 0) {
    queryBuilder = (queryBuilder as { or: (s: string) => typeof queryBuilder }).or(
      filters.join(","),
    );
  }

  queryBuilder = queryBuilder
    .order("display_name", { ascending: true, nullsFirst: false })
    .order("user_id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) {
    throw new EditWindowError(500, error.message);
  }

  const profiles = (data ?? []) as unknown as UserProfileRow[];
  const userIds = profiles.map((p) => p.user_id);

  // 같은 resource_key 의 window 만 한 번에 조회.
  const windowsByUser = new Map<string, EditWindowRow>();
  if (userIds.length > 0) {
    const { data: winData, error: winError } = await supabaseAdmin
      .from("user_edit_windows")
      .select(WINDOW_SELECT)
      .eq("resource_key", options.resourceKey)
      .in("user_id", userIds);
    if (winError) {
      throw new EditWindowError(500, winError.message);
    }
    for (const row of (winData ?? []) as unknown as EditWindowRow[]) {
      windowsByUser.set(row.user_id, row);
    }
  }

  const rows: EditWindowUserRow[] = profiles.map((p) => ({
    userId: p.user_id,
    displayName: p.display_name,
    authEmail: p.auth_email,
    contactEmail: p.contact_email,
    organizationSlug: p.organization_slug,
    window: windowsByUser.has(p.user_id)
      ? toDto(windowsByUser.get(p.user_id)!)
      : null,
  }));

  return {
    resourceKey: options.resourceKey,
    rows,
    total: count ?? 0,
    limit,
    offset,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// UPSERT: 한 사용자 X 한 resource_key 의 window 를 열거나 갱신.
// granted_by 는 호출한 admin 의 user_id (admin_users.id = auth user id).
// ─────────────────────────────────────────────────────────────────────────

export type UpsertEditWindowInput = {
  userId: string;
  resourceKey: string;
  openedAt: Date;
  expiresAt: Date;
  note: string | null;
  grantedBy: string | null;
};

export async function upsertEditWindow(
  input: UpsertEditWindowInput,
): Promise<EditWindowDto> {
  if (!isUuid(input.userId)) {
    throw new EditWindowError(400, "user_id must be a UUID");
  }
  if (!isEditableResourceKey(input.resourceKey)) {
    throw new EditWindowError(400, `Unknown resource_key: ${input.resourceKey}`);
  }
  if (
    Number.isNaN(input.openedAt.getTime()) ||
    Number.isNaN(input.expiresAt.getTime())
  ) {
    throw new EditWindowError(400, "opened_at / expires_at must be valid dates");
  }
  if (input.expiresAt.getTime() <= input.openedAt.getTime()) {
    throw new EditWindowError(400, "expires_at must be after opened_at");
  }

  // user_profiles 존재 확인 (FK 위반 시 친절한 메시지를 위해).
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", input.userId)
    .maybeSingle();
  if (profileError) {
    throw new EditWindowError(500, profileError.message);
  }
  if (!profile) {
    throw new EditWindowError(404, "user_profile not found");
  }

  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .upsert(
      {
        user_id: input.userId,
        resource_key: input.resourceKey,
        opened_at: input.openedAt.toISOString(),
        expires_at: input.expiresAt.toISOString(),
        note: input.note,
        granted_by: input.grantedBy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,resource_key" },
    )
    .select(WINDOW_SELECT)
    .single();

  if (error || !data) {
    throw new EditWindowError(
      500,
      error?.message ?? "Failed to upsert user_edit_windows",
    );
  }

  return toDto(data as unknown as EditWindowRow);
}

// ─────────────────────────────────────────────────────────────────────────
// CLOSE: expires_at = now 로 즉시 만료 처리.
// row 가 없으면 noop (열린 적 없는 사용자를 닫는 것은 의미가 없으므로 무시).
// ─────────────────────────────────────────────────────────────────────────

export async function closeEditWindow(
  userId: string,
  resourceKey: string,
): Promise<EditWindowDto | null> {
  if (!isUuid(userId)) {
    throw new EditWindowError(400, "user_id must be a UUID");
  }
  if (!isEditableResourceKey(resourceKey)) {
    throw new EditWindowError(400, `Unknown resource_key: ${resourceKey}`);
  }

  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .update({ expires_at: now, updated_at: now })
    .eq("user_id", userId)
    .eq("resource_key", resourceKey)
    .select(WINDOW_SELECT)
    .maybeSingle();

  if (error) {
    throw new EditWindowError(500, error.message);
  }

  if (!data) return null;
  return toDto(data as unknown as EditWindowRow);
}

// ─────────────────────────────────────────────────────────────────────────
// 단일 사용자 + resource 조회 — 사용자 앱 (예: /api/review-link) 측에서
// "현재 이 사용자가 이 resource 를 편집할 수 있나?" 를 판정할 때 사용.
// ─────────────────────────────────────────────────────────────────────────

export async function getEditWindowForUser(
  userId: string,
  resourceKey: string,
): Promise<EditWindowDto | null> {
  if (!isUuid(userId)) return null;
  if (!isEditableResourceKey(resourceKey)) return null;

  const { data, error } = await supabaseAdmin
    .from("user_edit_windows")
    .select(WINDOW_SELECT)
    .eq("user_id", userId)
    .eq("resource_key", resourceKey)
    .maybeSingle();

  if (error) {
    throw new EditWindowError(500, error.message);
  }
  if (!data) return null;
  return toDto(data as unknown as EditWindowRow);
}

export function isWindowActive(
  window: EditWindowDto | null,
  now: Date = new Date(),
): boolean {
  if (!window) return false;
  const opened = new Date(window.openedAt);
  const expires = new Date(window.expiresAt);
  if (Number.isNaN(opened.getTime()) || Number.isNaN(expires.getTime())) {
    return false;
  }
  return now >= opened && now <= expires;
}
