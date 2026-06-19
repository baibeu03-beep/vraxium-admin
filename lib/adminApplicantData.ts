import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { excludeSuperAdmins } from "@/lib/superAdmins";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  assertUserIdsInScope,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import {
  APPLICANT_STATUSES,
  isApplicantStatus,
  type AdminApplicantDto,
  type ApplicantStatus,
  type UserProfileCandidateDto,
} from "@/lib/adminApplicantTypes";

// Pure constants/types live in lib/adminApplicantTypes.ts so client components
// can import them without pulling supabaseAdmin into the browser bundle.
export {
  APPLICANT_STATUSES,
  isApplicantStatus,
  type AdminApplicantDto,
  type ApplicantStatus,
  type UserProfileCandidateDto,
};

type ApplicantRow = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  status: ApplicantStatus;
  linked_user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  contact_email: string | null;
  auth_email: string | null;
  organization_slug: string | null;
};

const APPLICANT_SELECT = [
  "id",
  "email",
  "name",
  "provider",
  "status",
  "linked_user_id",
  "created_at",
  "updated_at",
].join(",");

const USER_PROFILE_SELECT = [
  "user_id",
  "display_name",
  "contact_email",
  "auth_email",
  "organization_slug",
].join(",");

function isMissingApplicantsTableError(error: { code?: string; message?: string } | null) {
  return (
    error?.code === "PGRST205" ||
    error?.message?.includes("public.applicants") ||
    false
  );
}

function toApplicantDto(
  row: ApplicantRow,
  linkedDisplayName: string | null = null,
): AdminApplicantDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    status: row.status,
    linkedUserId: row.linked_user_id,
    linkedDisplayName,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Batch-fetch display_name for a set of linked user_ids and return a Map keyed
// by user_id. Empty/blank display_name becomes null so the UI can fall back to
// "이름 미등록" rather than rendering an empty cell.
async function fetchLinkedDisplayNames(userIds: string[]) {
  const map = new Map<string, string | null>();
  const unique = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))));
  if (unique.length === 0) return map;

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name")
    .in("user_id", unique);

  if (error) {
    console.error("[admin] fetchLinkedDisplayNames failed", { error });
    return map;
  }

  for (const row of (data ?? []) as { user_id: string; display_name: string | null }[]) {
    const name = row.display_name?.trim();
    map.set(row.user_id, name && name !== "" ? name : null);
  }
  return map;
}

function toUserProfileCandidateDto(row: UserProfileRow): UserProfileCandidateDto {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    contactEmail: row.contact_email,
    authEmail: row.auth_email,
    organizationSlug: row.organization_slug,
  };
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

async function fetchProfileIdsByApplicantEmails(rows: ApplicantRow[]) {
  const emails = Array.from(
    new Set(rows.map((row) => normalizeEmail(row.email)).filter(Boolean)),
  );
  const result = new Map<string, string[]>();
  if (emails.length === 0) return result;

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,auth_email,contact_email");
  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as Array<{
    user_id: string;
    auth_email: string | null;
    contact_email: string | null;
  }>) {
    for (const rawEmail of [row.auth_email, row.contact_email]) {
      const email = normalizeEmail(rawEmail);
      if (!email || !emails.includes(email)) continue;
      const ids = result.get(email) ?? [];
      if (!ids.includes(row.user_id)) ids.push(row.user_id);
      result.set(email, ids);
    }
  }
  return result;
}

export async function listApplicants(
  status?: ApplicantStatus,
  mode: ScopeMode = "operating",
) {
  let query = supabaseAdmin
    .from("applicants")
    .select(APPLICANT_SELECT)
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingApplicantsTableError(error)) {
      throw new Error(
        "applicants table is missing. Apply db/migrations/2026-05-08_admin_applicants.sql first.",
      );
    }
    throw new Error(error.message);
  }

  const rows = (data ?? []) as unknown as ApplicantRow[];
  const scope = await resolveUserScope(mode, null);
  const emailProfileIds = await fetchProfileIdsByApplicantEmails(rows);
  const scopedRows = rows.filter((row) => {
    if (row.linked_user_id) return scope.includes(row.linked_user_id);
    const matchedIds = emailProfileIds.get(normalizeEmail(row.email)) ?? [];
    if (matchedIds.length === 0) return mode === "operating";
    const matchedModes = new Set(
      matchedIds.map((userId) =>
        scope.testUserIds.has(userId) ? "test" : "operating",
      ),
    );
    return matchedModes.size === 1 && matchedModes.has(mode);
  });

  const linkedIds = scopedRows
    .map((row) => row.linked_user_id)
    .filter((id): id is string => Boolean(id));
  const displayNames = await fetchLinkedDisplayNames(linkedIds);
  return scopedRows.map((row) =>
    toApplicantDto(row, row.linked_user_id ? displayNames.get(row.linked_user_id) ?? null : null),
  );
}

export async function getApplicantById(id: string) {
  const { data, error } = await supabaseAdmin
    .from("applicants")
    .select(APPLICANT_SELECT)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    if (isMissingApplicantsTableError(error)) {
      throw new Error(
        "applicants table is missing. Apply db/migrations/2026-05-08_admin_applicants.sql first.",
      );
    }
    throw new Error(error.message);
  }

  if (!data) return null;
  const row = data as unknown as ApplicantRow;
  const displayNames = await fetchLinkedDisplayNames(
    row.linked_user_id ? [row.linked_user_id] : [],
  );
  return toApplicantDto(
    row,
    row.linked_user_id ? displayNames.get(row.linked_user_id) ?? null : null,
  );
}

export async function searchUserProfiles(
  query: string,
  mode: ScopeMode = "operating",
) {
  const rawQuery = query.trim();
  const trimmed = escapeForIlike(rawQuery);
  const filters = [
    ...(trimmed
      ? [
          `display_name.ilike.%${trimmed}%`,
          `contact_email.ilike.%${trimmed}%`,
          `auth_email.ilike.%${trimmed}%`,
          `organization_slug.ilike.%${trimmed}%`,
        ]
      : []),
    ...(isUuid(rawQuery) ? [`user_id.eq.${rawQuery}`] : []),
  ];

  if (filters.length === 0) return [];

  // super admin 은 멤버 검색/자동완성 결과에서 제외 (목록 노출에서만 숨김).
  const scope = await resolveUserScope(mode, null);
  let builder = excludeSuperAdmins(
    supabaseAdmin
      .from("user_profiles")
      .select(USER_PROFILE_SELECT)
      .or(filters.join(",")),
  );
  if (scope.mode === "test") {
    const ids = scope.includeUserIds ?? [];
    if (ids.length === 0) return [];
    builder = builder.in("user_id", ids);
  } else if (scope.excludeUserIds.length > 0) {
    builder = builder.not("user_id", "in", `(${scope.excludeUserIds.join(",")})`);
  }
  const { data, error } = await builder
    .order("display_name", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as unknown as UserProfileRow[]).map(toUserProfileCandidateDto);
}

export async function findUserProfilesByEmail(
  email: string,
  mode: ScopeMode = "operating",
) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  const scope = await resolveUserScope(mode, null);

  const load = async (column: "auth_email" | "contact_email") => {
    let builder = excludeSuperAdmins(
      supabaseAdmin
        .from("user_profiles")
        .select(USER_PROFILE_SELECT)
        .ilike(column, normalized),
    );
    if (scope.mode === "test") {
      const ids = scope.includeUserIds ?? [];
      if (ids.length === 0) return [];
      builder = builder.in("user_id", ids);
    } else if (scope.excludeUserIds.length > 0) {
      builder = builder.not(
        "user_id",
        "in",
        `(${scope.excludeUserIds.join(",")})`,
      );
    }
    const { data, error } = await builder.order("display_name", {
      ascending: true,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as unknown as UserProfileRow[]).map(
      toUserProfileCandidateDto,
    );
  };

  const authMatches = await load("auth_email");
  return authMatches.length > 0 ? authMatches : load("contact_email");
}

export async function approveApplicant(
  applicantId: string,
  userId: string,
  mode: ScopeMode = "operating",
) {
  const applicant = (await listApplicants(undefined, mode)).find(
    (row) => row.id === applicantId,
  );
  if (!applicant) {
    throw new Error("Applicant not found");
  }
  if (applicant.status !== "pending") {
    throw new Error(`Only pending applicants can be approved. Current status: ${applicant.status}`);
  }
  if (applicant.linkedUserId && applicant.linkedUserId !== userId) {
    throw new Error(
      `Applicant is already linked to user ${applicant.linkedUserId}. Reset the link before re-approving.`,
    );
  }

  const authEmail = normalizeEmail(applicant.email);
  if (!authEmail) {
    throw new Error("Applicant email is required to create a login link.");
  }

  const { data: targetRow, error: targetError } = await supabaseAdmin
    .from("user_profiles")
    .select(USER_PROFILE_SELECT)
    .eq("user_id", userId)
    .maybeSingle();

  if (targetError) {
    throw new Error(targetError.message);
  }
  if (!targetRow) {
    throw new Error("Selected user_profile was not found");
  }
  const scope = await resolveUserScope(mode, null);
  assertUserIdsInScope(scope, [userId]);

  const target = targetRow as unknown as UserProfileRow;
  const currentAuthEmail = normalizeEmail(target.auth_email);
  if (currentAuthEmail && currentAuthEmail !== authEmail) {
    throw new Error(
      `Selected user_profile already has auth_email ${target.auth_email}. Clear or review that link first.`,
    );
  }

  const { data: duplicates, error: duplicateError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,auth_email")
    .ilike("auth_email", authEmail)
    .neq("user_id", userId);

  if (duplicateError) {
    throw new Error(duplicateError.message);
  }
  if ((duplicates ?? []).length > 0) {
    throw new Error(`auth_email ${authEmail} is already linked to another user_profile.`);
  }

  const { data: updatedProfile, error: updateProfileError } = await supabaseAdmin
    .from("user_profiles")
    .update({ auth_email: authEmail })
    .eq("user_id", userId)
    .select(USER_PROFILE_SELECT)
    .single();

  if (updateProfileError) {
    if (updateProfileError.code === "23505") {
      throw new Error(`auth_email ${authEmail} is already linked to another user_profile.`);
    }
    throw new Error(updateProfileError.message);
  }

  const { data: updatedApplicant, error: updateApplicantError } = await supabaseAdmin
    .from("applicants")
    .update({
      status: "approved",
      linked_user_id: userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", applicantId)
    .select(APPLICANT_SELECT)
    .single();

  if (updateApplicantError) {
    throw new Error(updateApplicantError.message);
  }

  const profileDto = toUserProfileCandidateDto(updatedProfile as unknown as UserProfileRow);
  return {
    applicant: toApplicantDto(
      updatedApplicant as unknown as ApplicantRow,
      profileDto.displayName,
    ),
    profile: profileDto,
  };
}

// Backwards-compatible alias for the pre-approve naming.
export const linkApplicantToUserProfile = approveApplicant;

// 승인 실패를 status(+선택 step/details)와 함께 전달하는 에러 — 라우트가 그대로 응답에 매핑한다.
export class ApplicantApprovalError extends Error {
  status: number;
  step?: string;
  details?: unknown;
  constructor(
    message: string,
    status: number,
    opts?: { step?: string; details?: unknown },
  ) {
    super(message);
    this.name = "ApplicantApprovalError";
    this.status = status;
    this.step = opts?.step;
    this.details = opts?.details;
  }
}

export type ApplicantAutoApprovalResult = {
  approvalKind: "existing" | "new";
  linkedUserId: string;
};

// 단건 자동 승인(find-or-create) — 기존 approve-new 라우트의 로직을 그대로 옮긴 단일 SoT.
//   · applicant.email 로 기존 user_profile 정확 매칭 → approveApplicant 로 연결(approvalKind="existing").
//   · 매칭 0 + operating → users/user_profiles 신규 생성 + applicant 승인 + auth_accounts 링크 + snapshot(approvalKind="new").
//   · 매칭 0 + test → 신규 생성 불가(422). 매칭 2+ → 모호(409).
// 단건 라우트(approve-new)와 일괄 승인(approve-all)이 이 함수 하나만 호출 → 사용자 생성/연결 경로 단일화.
export async function autoApproveApplicant(
  applicantId: string,
  mode: ScopeMode = "operating",
): Promise<ApplicantAutoApprovalResult> {
  const { data: applicant, error: applicantError } = await supabaseAdmin
    .from("applicants")
    .select("id, email, provider, status, name, provider_user_id")
    .eq("id", applicantId)
    .single();

  if (applicantError || !applicant) {
    throw new ApplicantApprovalError("Applicant not found", 404);
  }

  if (applicant.status !== "pending") {
    throw new ApplicantApprovalError("Applicant is not pending", 409);
  }

  if (!applicant.email) {
    throw new ApplicantApprovalError(
      "Applicant email is required to create a user profile",
      400,
    );
  }

  const visibleInMode = (await listApplicants(undefined, mode)).some(
    (row) => row.id === applicantId,
  );
  if (!visibleInMode) {
    throw new ApplicantApprovalError(
      `Applicant is outside ${mode} mode scope`,
      422,
    );
  }

  const exactMatches = await findUserProfilesByEmail(applicant.email, mode);
  if (exactMatches.length > 1) {
    throw new ApplicantApprovalError(
      "Multiple existing user profiles match applicant.email",
      409,
    );
  }
  if (exactMatches.length === 1) {
    const linked = await approveApplicant(
      applicantId,
      exactMatches[0].userId,
      mode,
    );
    return { approvalKind: "existing", linkedUserId: linked.profile.userId };
  }
  if (mode === "test") {
    throw new ApplicantApprovalError(
      "Unlinked applicants cannot create a test user because applicants has no mode/user_id marker.",
      422,
    );
  }

  const newUserId = randomUUID();
  const fallbackName =
    applicant.name && applicant.name !== "kakao-user"
      ? applicant.name
      : applicant.email.split("@")[0];

  const { error: userInsertError } = await supabaseAdmin
    .from("users")
    .insert({
      id: newUserId,
    });

  if (userInsertError) {
    console.error("approve-new userInsertError", userInsertError);
    throw new ApplicantApprovalError(
      userInsertError.message ?? "Failed to create user",
      500,
      { step: "insert_users", details: userInsertError },
    );
  }

  const now = new Date();
  const dow = now.getDay();
  const mon = new Date(now);
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const activityStartedAt = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, "0")}-${String(mon.getDate()).padStart(2, "0")}T00:00:00+09:00`;

  const { data: newProfile, error: insertError } = await supabaseAdmin
    .from("user_profiles")
    .insert({
      user_id: newUserId,
      display_name: fallbackName,
      auth_email: applicant.email,
      contact_email: applicant.email,
      status: "active",
      growth_status: "active",
      activity_started_at: activityStartedAt,
    })
    .select("user_id")
    .single();

  if (insertError || !newProfile) {
    console.error("approve-new insertError", insertError);
    const { error: rollbackUserError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUserId);
    if (rollbackUserError) {
      console.error(
        "approve-new rollback users delete failed",
        rollbackUserError,
      );
    }
    throw new ApplicantApprovalError(
      insertError?.message ?? "Failed to create user profile",
      500,
      { step: "insert_user_profile", details: insertError },
    );
  }

  const { error: applicantUpdateError } = await supabaseAdmin
    .from("applicants")
    .update({
      status: "approved",
      linked_user_id: newProfile.user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", applicantId);

  if (applicantUpdateError) {
    console.error("approve-new applicantUpdateError", applicantUpdateError);
    const { error: rollbackProfileError } = await supabaseAdmin
      .from("user_profiles")
      .delete()
      .eq("user_id", newUserId);
    if (rollbackProfileError) {
      console.error(
        "approve-new rollback user_profiles delete failed",
        rollbackProfileError,
      );
    }
    const { error: rollbackUserError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUserId);
    if (rollbackUserError) {
      console.error(
        "approve-new rollback users delete failed",
        rollbackUserError,
      );
    }
    throw new ApplicantApprovalError(applicantUpdateError.message, 500, {
      step: "update_applicant",
      details: applicantUpdateError,
    });
  }

  // google 신청은 provider 계정(auth_accounts)에 user_id 링크 — 매칭 키가 email 이 아닌
  // (provider, provider_user_id) 이므로 여기서 연결해야 다음 로그인이 approved 로 풀린다.
  // best-effort: 실패해도 고객 앱 resolveGoogleAccountAccess 가 applicants.linked_user_id 로 self-heal.
  if (applicant.provider === "google" && applicant.provider_user_id) {
    const { error: linkError } = await supabaseAdmin
      .from("auth_accounts")
      .update({
        user_id: newProfile.user_id,
        updated_at: new Date().toISOString(),
      })
      .eq("provider", "google")
      .eq("provider_user_id", applicant.provider_user_id);

    if (linkError) {
      console.warn("approve-new auth_accounts link failed (non-fatal)", {
        applicantId,
        message: linkError.message,
      });
    }
  }

  // 신규 유저 snapshot 최초 생성(쓰기 시점). uws 가 아직 없으면 빈 카드로 저장 → 조회 시
  // miss→fallback(실시간 계산) 대신 hit 으로 응답. best-effort — 실패해도 승인은 유지.
  try {
    await recomputeAndStoreWeeklyCardsSnapshot(newProfile.user_id);
  } catch (snapErr) {
    console.warn("approve-new initial snapshot create failed (non-fatal)", {
      userId: newProfile.user_id,
      message: snapErr instanceof Error ? snapErr.message : String(snapErr),
    });
  }

  return { approvalKind: "new", linkedUserId: newProfile.user_id };
}

// 일괄 자동 승인 — 현재 mode 스코프의 pending 지원자 전원을 autoApproveApplicant 로 순차 처리.
//   · listApplicants("pending", mode) 가 단건 UI 와 동일한 스코프 모집단(이미 승인/거절 제외) 제공.
//   · per-applicant try/catch 로 일부 실패해도 전체 중단하지 않고 결과를 모은다.
//   · 멱등: 재호출 시 이미 approved 인 지원자는 pending 목록에서 빠져 재처리되지 않는다.
export type BulkApproveItemResult = {
  id: string;
  email: string | null;
  name: string | null;
  ok: boolean;
  approvalKind?: "existing" | "new";
  linkedUserId?: string;
  status?: number;
  error?: string;
};

export type BulkApproveResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkApproveItemResult[];
};

export async function approveAllPendingApplicants(
  mode: ScopeMode = "operating",
): Promise<BulkApproveResult> {
  const pending = await listApplicants("pending", mode);
  const results: BulkApproveItemResult[] = [];

  for (const applicant of pending) {
    try {
      const r = await autoApproveApplicant(applicant.id, mode);
      results.push({
        id: applicant.id,
        email: applicant.email,
        name: applicant.name,
        ok: true,
        approvalKind: r.approvalKind,
        linkedUserId: r.linkedUserId,
      });
    } catch (error) {
      const status =
        error instanceof ApplicantApprovalError
          ? error.status
          : (error as { status?: number })?.status;
      results.push({
        id: applicant.id,
        email: applicant.email,
        name: applicant.name,
        ok: false,
        status,
        error:
          error instanceof Error ? error.message : "Failed to approve applicant",
      });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}

export async function rejectApplicant(
  applicantId: string,
  mode: ScopeMode = "operating",
) {
  const applicant = (await listApplicants(undefined, mode)).find(
    (row) => row.id === applicantId,
  );
  if (!applicant) {
    throw new Error("Applicant not found");
  }
  if (applicant.status !== "pending") {
    throw new Error(`Only pending applicants can be rejected. Current status: ${applicant.status}`);
  }

  const { data, error } = await supabaseAdmin
    .from("applicants")
    .update({
      status: "rejected",
    })
    .eq("id", applicantId)
    .select(APPLICANT_SELECT)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toApplicantDto(data as unknown as ApplicantRow);
}
