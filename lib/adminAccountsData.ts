import { randomBytes } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  ORGANIZATIONS,
  isOrganizationSlug,
  type OrganizationSlug,
} from "@/lib/organizations";
import {
  ADMIN_USERS_ROLES,
  ADMIN_USERS_ROLE_LABELS,
  isAdminUsersRole,
  isUserFacingRole,
  userProfileRoleForAdminUsersRole,
  type AccountDto,
  type AdminUsersRole,
  type CreateAccountPayload,
  type CreateAccountResult,
  type ListAccountsResult,
  type ResetPasswordResult,
  type UpdateAccountPayload,
  type UserFacingRole,
} from "@/lib/adminAccountsTypes";
import { fieldLabel, withJosa } from "@/lib/apiFieldLabels";

// /admin/settings/accounts 전용 server-only 데이터 레이어.
//
// PRIMARY 데이터 소스: public.admin_users
//   - 본 페이지는 어드민 페이지에 로그인할 수 있는 "운영 계정" 만 다룬다.
//   - 일반 소셜 로그인 회원(프론트 사용자)은 user_profiles 에만 존재하며 본 페이지 노출 대상이 아님.
//
// JOIN: public.user_profiles
//   - 표시용 부가 정보(display_name, organization_slug, contact_email)
//   - 서비스 역할 동기화(user_profiles.role ← admin_users.role 매핑)
//
// 작성: public.users + public.user_profiles + public.admin_users 모두 생성
// 변경: admin_users 가 primary, user_profiles 는 매핑으로 동기화

export {
  ADMIN_USERS_ROLES,
  ADMIN_USERS_ROLE_LABELS,
  isAdminUsersRole,
  isUserFacingRole,
  userProfileRoleForAdminUsersRole,
};
export type {
  AccountDto,
  AdminUsersRole,
  CreateAccountPayload,
  CreateAccountResult,
  ListAccountsResult,
  ResetPasswordResult,
  UpdateAccountPayload,
  UserFacingRole,
};

export class AccountsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AccountsError";
    this.status = status;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────────────────────────────
type AdminUserRow = {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
  created_at: string | null;
  updated_at: string | null;
};

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  auth_email: string | null;
  contact_email: string | null;
  organization_slug: string | null;
  role: string | null;
};

const ADMIN_USER_SELECT = "id,email,role,is_active,created_at,updated_at";
const PROFILE_SELECT =
  "user_id,display_name,auth_email,contact_email,organization_slug,role";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function validateEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new AccountsError(400, "이메일을 입력해주세요.");
  }
  const normalized = normalizeEmail(value);
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new AccountsError(400, "이메일 형식이 올바르지 않습니다.");
  }
  return normalized;
}

// 관리자 이름 최대 길이 — 프론트(AccountsManager input maxLength)와 동일하게 유지.
export const DISPLAY_NAME_MAX_LENGTH = 50;

function validateDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new AccountsError(400, "이름을 입력해주세요.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new AccountsError(400, "이름을 입력해주세요.");
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new AccountsError(
      400,
      `이름은 ${DISPLAY_NAME_MAX_LENGTH}자 이하여야 합니다.`,
    );
  }
  return trimmed;
}

function validateOrganizationSlug(value: unknown): OrganizationSlug | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (!isOrganizationSlug(trimmed)) {
      throw new AccountsError(400, "선택할 수 없는 소속 클럽입니다.");
    }
    return trimmed;
  }
  throw new AccountsError(400, "소속 클럽 값이 올바르지 않습니다.");
}

function validateAdminRole(value: unknown): AdminUsersRole {
  if (!isAdminUsersRole(value)) {
    throw new AccountsError(400, "선택할 수 없는 권한 등급입니다.");
  }
  return value;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    // 필드명은 사용자 용어로 — 라벨이 없으면 범용 문구(내부 이름 노출 금지).
    const label = fieldLabel(field);
    throw new AccountsError(
      400,
      label ? `${withJosa(label, "이/가")} 올바르지 않습니다.` : "입력값이 올바르지 않습니다.",
    );
  }
  return value;
}

function toAccountDto(
  admin: AdminUserRow,
  profile: UserProfileRow | null,
): AccountDto {
  // admin_users.role 은 DB CHECK 제약으로 owner/admin/viewer 만 들어오지만,
  // 만약 운영 DB 에 invalid 값이 들어와 있더라도 페이지가 죽지 않도록 fallback 처리.
  const adminRole: AdminUsersRole = isAdminUsersRole(admin.role)
    ? admin.role
    : "viewer";

  return {
    userId: admin.id,
    email: admin.email,
    adminRole,
    isActive: Boolean(admin.is_active),
    createdAt: admin.created_at,
    updatedAt: admin.updated_at,
    displayName: profile?.display_name ?? null,
    authEmail: profile?.auth_email ?? null,
    contactEmail: profile?.contact_email ?? null,
    organizationSlug: profile?.organization_slug ?? null,
    userProfileRole:
      profile && isUserFacingRole(profile.role) ? profile.role : null,
  };
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

// ─────────────────────────────────────────────────────────────────────
// LIST — admin_users 가 primary, user_profiles 는 enrichment.
// ─────────────────────────────────────────────────────────────────────
export type ListAccountsOptions = {
  query?: string | null;
  adminRole?: AdminUsersRole | null;
  isActive?: boolean | null;
  limit?: number;
  offset?: number;
  isSuperAdmin: boolean;
};

export async function listAccounts(
  options: ListAccountsOptions,
): Promise<ListAccountsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let queryBuilder = supabaseAdmin
    .from("admin_users")
    .select(ADMIN_USER_SELECT, { count: "exact" });

  if (options.adminRole) {
    queryBuilder = queryBuilder.eq("role", options.adminRole);
  }
  if (options.isActive !== null && options.isActive !== undefined) {
    queryBuilder = queryBuilder.eq("is_active", options.isActive);
  }

  const rawQuery = options.query?.trim() ?? "";
  if (rawQuery) {
    const escaped = escapeForIlike(rawQuery);
    const filters = [
      ...(escaped ? [`email.ilike.%${escaped}%`] : []),
      ...(isUuid(rawQuery) ? [`id.eq.${rawQuery}`] : []),
    ];
    if (filters.length > 0) {
      queryBuilder = queryBuilder.or(filters.join(","));
    }
  }

  queryBuilder = queryBuilder
    .order("created_at", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) {
    console.error("[accounts] list query failed", error);
    throw new AccountsError(500, "계정 목록을 불러오지 못했습니다.");
  }

  const adminRows = (data ?? []) as unknown as AdminUserRow[];
  const userIds = adminRows.map((r) => r.id);

  const profileByUserId = new Map<string, UserProfileRow>();
  if (userIds.length > 0) {
    const { data: profileData, error: profileError } = await supabaseAdmin
      .from("user_profiles")
      .select(PROFILE_SELECT)
      .in("user_id", userIds);
    if (profileError) {
      console.error("[accounts] profile join failed", profileError);
      throw new AccountsError(500, "계정 목록을 불러오지 못했습니다.");
    }
    for (const row of (profileData ?? []) as unknown as UserProfileRow[]) {
      profileByUserId.set(row.user_id, row);
    }
  }

  const accounts = adminRows.map((row) =>
    toAccountDto(row, profileByUserId.get(row.id) ?? null),
  );

  return {
    accounts,
    total: count ?? 0,
    limit,
    offset,
    isSuperAdmin: options.isSuperAdmin,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 단건 조회 — PATCH 전후 / 응답 직렬화에 사용
// ─────────────────────────────────────────────────────────────────────
export async function getAccount(userId: string): Promise<AccountDto | null> {
  if (!isUuid(userId)) {
    throw new AccountsError(400, "대상 계정을 찾을 수 없습니다.");
  }
  const [adminRes, profileRes] = await Promise.all([
    supabaseAdmin
      .from("admin_users")
      .select(ADMIN_USER_SELECT)
      .eq("id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_profiles")
      .select(PROFILE_SELECT)
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  if (adminRes.error || profileRes.error) {
    console.error("[accounts] load failed", adminRes.error ?? profileRes.error);
    throw new AccountsError(500, "계정 정보를 불러오지 못했습니다.");
  }

  if (!adminRes.data) return null;
  return toAccountDto(
    adminRes.data as unknown as AdminUserRow,
    (profileRes.data ?? null) as unknown as UserProfileRow | null,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 임시 비밀번호 — 모호한 문자(O/0/I/l/1) 제외 56자 alphabet × 14자 + 'Vrx-' prefix
// ─────────────────────────────────────────────────────────────────────
const PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generateTemporaryPassword(): string {
  const len = 14;
  const buf = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += PASSWORD_ALPHABET[buf[i] % PASSWORD_ALPHABET.length];
  }
  return "Vrx-" + out;
}

// ─────────────────────────────────────────────────────────────────────
// CREATE — Supabase auth.users → users → user_profiles → admin_users → audit
//   각 단계 실패 시 역순 rollback.
//   user_profiles.role 은 admin_role 의 매핑값으로 동기화.
// ─────────────────────────────────────────────────────────────────────
export type CreateAccountInput = {
  payload: CreateAccountPayload;
  actorId: string;
};

export async function createAccount(
  input: CreateAccountInput,
): Promise<CreateAccountResult> {
  const displayName = validateDisplayName(input.payload.display_name);
  const email = validateEmail(input.payload.email);
  const organizationSlug = validateOrganizationSlug(
    input.payload.organization_slug,
  );
  const adminRole = validateAdminRole(input.payload.admin_role);
  const isActive =
    input.payload.is_active === undefined
      ? true
      : validateBoolean(input.payload.is_active, "is_active");
  const sendInviteEmail = Boolean(input.payload.send_invite_email);
  const userProfileRole = userProfileRoleForAdminUsersRole(adminRole);

  // ── 사전 중복 검사 ────────────────────────────────────────────────
  // admin_users.email 도 lower(email) unique index 가 있고, user_profiles.auth_email
  // 도 동일한 unique index 가 있다. 친절한 에러 메시지용 사전 SELECT.
  const { data: existingAdmin, error: adminDupError } = await supabaseAdmin
    .from("admin_users")
    .select("id,email")
    .ilike("email", email)
    .maybeSingle();
  if (adminDupError && adminDupError.code !== "PGRST116") {
    console.error("[accounts] admin dup check failed", adminDupError);
    throw new AccountsError(500, "계정을 생성하지 못했습니다.");
  }
  if (existingAdmin) {
    throw new AccountsError(409, `이미 운영 계정으로 등록된 이메일입니다: ${email}`);
  }

  const { data: existingProfile, error: profileDupError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,auth_email")
    .ilike("auth_email", email)
    .maybeSingle();
  if (profileDupError && profileDupError.code !== "PGRST116") {
    console.error("[accounts] profile dup check failed", profileDupError);
    throw new AccountsError(500, "계정을 생성하지 못했습니다.");
  }
  if (existingProfile) {
    throw new AccountsError(
      409,
      `이미 사용자로 등록된 이메일입니다: ${email}`,
    );
  }

  // ── Step 1: Supabase auth.users 생성 ─────────────────────────────
  const temporaryPassword = sendInviteEmail ? null : generateTemporaryPassword();
  const createAuthResult = sendInviteEmail
    ? await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: { display_name: displayName, created_by_admin: true },
      })
    : await supabaseAdmin.auth.admin.createUser({
        email,
        password: temporaryPassword!,
        email_confirm: true,
        user_metadata: { display_name: displayName, created_by_admin: true },
      });

  if (createAuthResult.error || !createAuthResult.data?.user) {
    // Supabase auth 원문은 사용자에게 노출하지 않는다(로그 전용).
    console.error("[accounts] auth user create failed", createAuthResult.error);
    throw new AccountsError(500, "계정을 생성하지 못했습니다.");
  }

  const newUserId = createAuthResult.data.user.id;

  // ── 실패 시 rollback 헬퍼 ────────────────────────────────────────
  const rollback = async (
    steps: Array<"admin_users" | "user_profiles" | "users" | "auth">,
  ) => {
    for (const step of steps) {
      try {
        if (step === "admin_users") {
          await supabaseAdmin.from("admin_users").delete().eq("id", newUserId);
        } else if (step === "user_profiles") {
          await supabaseAdmin
            .from("user_profiles")
            .delete()
            .eq("user_id", newUserId);
        } else if (step === "users") {
          await supabaseAdmin.from("users").delete().eq("id", newUserId);
        } else if (step === "auth") {
          await supabaseAdmin.auth.admin.deleteUser(newUserId);
        }
      } catch (cleanupErr) {
        console.error("[createAccount] rollback step failed", {
          step,
          newUserId,
          error: cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
        });
      }
    }
  };

  // ── Step 2: public.users insert (legacy_user_id sequence default) ──
  const usersInsert = await supabaseAdmin
    .from("users")
    .insert({ id: newUserId });
  if (usersInsert.error) {
    // 롤백 순서 불변 — 원문은 로그로만, 사용자에게는 안전 문구.
    await rollback(["auth"]);
    console.error("[accounts] users insert failed", usersInsert.error);
    throw new AccountsError(500, "계정을 생성하지 못했습니다.");
  }

  // ── Step 3: user_profiles insert ─────────────────────────────────
  const now = new Date();
  const dow = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const activityStartedAt = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}T00:00:00+09:00`;

  const profileInsert = await supabaseAdmin.from("user_profiles").insert({
    user_id: newUserId,
    auth_email: email,
    contact_email: email,
    display_name: displayName,
    organization_slug: organizationSlug,
    role: userProfileRole,
    status: isActive ? "active" : "inactive",
    growth_status: "active",
    activity_started_at: activityStartedAt,
  });
  if (profileInsert.error) {
    await rollback(["users", "auth"]);
    console.error("[accounts] user_profiles insert failed", profileInsert.error);
    // 23505 = unique 위반 → 사용자가 고칠 수 있는 중복이므로 409 + 업무 문구.
    throw new AccountsError(
      profileInsert.error.code === "23505" ? 409 : 500,
      profileInsert.error.code === "23505"
        ? "이미 등록된 이메일입니다. 다른 이메일을 사용해주세요."
        : "계정을 생성하지 못했습니다.",
    );
  }

  // ── Step 4: admin_users insert (운영 계정 정체성 핵심) ───────────
  const adminInsert = await supabaseAdmin.from("admin_users").insert({
    id: newUserId,
    email,
    role: adminRole,
    is_active: isActive,
  });
  if (adminInsert.error) {
    await rollback(["user_profiles", "users", "auth"]);
    console.error("[accounts] admin_users insert failed", adminInsert.error);
    throw new AccountsError(
      adminInsert.error.code === "23505" ? 409 : 500,
      adminInsert.error.code === "23505"
        ? "이미 운영 계정으로 등록된 이메일입니다."
        : "계정을 생성하지 못했습니다.",
    );
  }

  // ── Step 5: audit (best-effort) ──────────────────────────────────
  const { error: auditError } = await supabaseAdmin
    .from("user_role_audit")
    .insert({
      user_id: newUserId,
      old_role: null,
      new_role: userProfileRole,
      changed_by: input.actorId,
      reason: `created via /admin/settings/accounts (admin_role=${adminRole})`,
    });
  if (auditError) {
    console.error("[createAccount] audit insert failed", {
      newUserId,
      error: auditError.message,
    });
  }

  // 신규 유저 snapshot 최초 생성(쓰기 시점). uws 가 아직 없으면 빈 카드로 저장되어
  // 조회 시 miss→fallback(실시간 계산) 대신 hit(빈 배열)로 빠르게 응답된다. best-effort.
  try {
    await recomputeAndStoreWeeklyCardsSnapshot(newUserId);
  } catch (e) {
    console.warn("[createAccount] initial snapshot create failed (non-fatal)", {
      newUserId,
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const created = await getAccount(newUserId);
  if (!created) {
    {
      console.error("[accounts] created but reload failed", { newUserId });
      throw new AccountsError(500, "계정은 생성됐지만 목록 새로고침에 실패했습니다. 목록을 다시 불러와주세요.");
    }
  }
  return {
    account: created,
    temporary_password: temporaryPassword,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 마지막 활성 owner(=super_admin 게이트) 가드
//   target 을 제외한 활성 owner 가 0명이면 차단.
// ─────────────────────────────────────────────────────────────────────
async function assertNotLastActiveOwner(targetUserId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("admin_users")
    .select("id")
    .eq("role", "owner")
    .eq("is_active", true)
    .neq("id", targetUserId);
  if (error) {
    console.error("[accounts] owner guard check failed", error);
    throw new AccountsError(500, "계정 정보를 확인하지 못했습니다.");
  }
  if (!data || data.length === 0) {
    throw new AccountsError(
      409,
      "마지막 최고 관리자는 강등하거나 비활성화할 수 없습니다.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// UPDATE — admin_users primary 갱신 + user_profiles 동기화 + audit
// ─────────────────────────────────────────────────────────────────────
export type UpdateAccountInput = {
  userId: string;
  payload: UpdateAccountPayload;
  actorId: string;
};

export async function updateAccount(
  input: UpdateAccountInput,
): Promise<AccountDto> {
  if (!isUuid(input.userId)) {
    throw new AccountsError(400, "user_id must be a UUID");
  }

  const current = await getAccount(input.userId);
  if (!current) throw new AccountsError(404, "Account not found");

  const newAdminRole =
    input.payload.admin_role !== undefined
      ? validateAdminRole(input.payload.admin_role)
      : null;
  const newIsActive =
    input.payload.is_active !== undefined
      ? validateBoolean(input.payload.is_active, "is_active")
      : null;

  // ── 마지막 활성 owner 가드 ────────────────────────────────────────
  // current 가 owner+active 인데 이 PATCH 로 owner 권한이 사라지거나 비활성화되면
  // 다른 활성 owner 가 최소 1명 남아야 한다.
  const isLosingOwner =
    current.adminRole === "owner" &&
    current.isActive &&
    ((newAdminRole !== null && newAdminRole !== "owner") || newIsActive === false);
  if (isLosingOwner) {
    await assertNotLastActiveOwner(input.userId);
  }

  // ── admin_users UPDATE ───────────────────────────────────────────
  const adminPatch: Record<string, unknown> = {};
  if (newAdminRole !== null) adminPatch.role = newAdminRole;
  if (newIsActive !== null) adminPatch.is_active = newIsActive;
  if (Object.keys(adminPatch).length > 0) {
    const { error } = await supabaseAdmin
      .from("admin_users")
      .update(adminPatch)
      .eq("id", input.userId);
    if (error) {
      throw new AccountsError(500, `Failed to update admin_users: ${error.message}`);
    }
  }

  // ── user_profiles UPDATE — 메타 + role 동기화 ─────────────────────
  const profilePatch: Record<string, unknown> = {};
  if (input.payload.display_name !== undefined) {
    profilePatch.display_name = validateDisplayName(input.payload.display_name);
  }
  if (input.payload.contact_email !== undefined) {
    if (input.payload.contact_email === null) {
      profilePatch.contact_email = null;
    } else {
      profilePatch.contact_email = validateEmail(input.payload.contact_email);
    }
  }
  if (input.payload.organization_slug !== undefined) {
    profilePatch.organization_slug = validateOrganizationSlug(
      input.payload.organization_slug,
    );
  }
  if (newAdminRole !== null) {
    profilePatch.role = userProfileRoleForAdminUsersRole(newAdminRole);
  }
  if (newIsActive !== null) {
    profilePatch.status = newIsActive ? "active" : "inactive";
  }
  if (Object.keys(profilePatch).length > 0) {
    const { data: updatedProfiles, error } = await supabaseAdmin
      .from("user_profiles")
      .update(profilePatch)
      .eq("user_id", input.userId)
      .select("user_id");
    if (error) {
      throw new AccountsError(
        500,
        `Failed to update user_profiles: ${error.message}`,
      );
    }
    // display_name 수정 요청인데 user_profiles row 가 없으면 조용히 no-op 되어
    // "저장됐는데 안 바뀜" 으로 보인다 — 명시적으로 실패시킨다.
    // (role/status 동기화만 있는 기존 경로는 종전대로 조용히 통과.)
    if (
      input.payload.display_name !== undefined &&
      (!updatedProfiles || updatedProfiles.length === 0)
    ) {
      throw new AccountsError(
        404,
        "user_profiles row 가 없어 이름을 저장하지 못했습니다.",
      );
    }
  }

  // ── audit (user_profiles.role 가 실제로 변한 경우만) ─────────────
  if (newAdminRole !== null) {
    const newServiceRole = userProfileRoleForAdminUsersRole(newAdminRole);
    if (newServiceRole !== current.userProfileRole) {
      const reason =
        typeof input.payload.reason === "string"
          ? input.payload.reason.trim() || null
          : null;
      const { error } = await supabaseAdmin.from("user_role_audit").insert({
        user_id: input.userId,
        old_role: current.userProfileRole,
        new_role: newServiceRole,
        changed_by: input.actorId,
        reason: reason ?? `admin_role: ${current.adminRole} → ${newAdminRole}`,
      });
      if (error) {
        console.error("[updateAccount] audit insert failed", {
          userId: input.userId,
          error: error.message,
        });
      }
    }
  }

  const updated = await getAccount(input.userId);
  if (!updated) {
    throw new AccountsError(500, "Account updated but reload failed");
  }
  return updated;
}

// ─────────────────────────────────────────────────────────────────────
// PASSWORD RESET — auth.users 비밀번호를 새 임시 비밀번호로 즉시 교체
// ─────────────────────────────────────────────────────────────────────
export async function resetAccountPassword(
  userId: string,
): Promise<ResetPasswordResult> {
  if (!isUuid(userId)) {
    throw new AccountsError(400, "user_id must be a UUID");
  }
  const account = await getAccount(userId);
  if (!account) throw new AccountsError(404, "Account not found");

  const newPassword = generateTemporaryPassword();
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (error) {
    throw new AccountsError(500, `Failed to reset password: ${error.message}`);
  }
  return { temporary_password: newPassword };
}

export { ORGANIZATIONS };
