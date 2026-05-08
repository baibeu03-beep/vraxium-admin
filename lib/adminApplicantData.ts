import { supabaseAdmin } from "@/lib/supabaseAdmin";
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

function toApplicantDto(row: ApplicantRow): AdminApplicantDto {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    provider: row.provider,
    status: row.status,
    linkedUserId: row.linked_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export async function listApplicants(status?: ApplicantStatus) {
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

  return ((data ?? []) as unknown as ApplicantRow[]).map(toApplicantDto);
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

  return data ? toApplicantDto(data as unknown as ApplicantRow) : null;
}

export async function searchUserProfiles(query: string) {
  const trimmed = escapeForIlike(query);
  if (!trimmed) return [];

  const pattern = `%${trimmed}%`;
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select(USER_PROFILE_SELECT)
    .or(
      [
        `display_name.ilike.${pattern}`,
        `contact_email.ilike.${pattern}`,
        `auth_email.ilike.${pattern}`,
        `organization_slug.ilike.${pattern}`,
        `user_id.ilike.${pattern}`,
      ].join(","),
    )
    .order("display_name", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(error.message);
  }

  return ((data ?? []) as unknown as UserProfileRow[]).map(toUserProfileCandidateDto);
}

export async function approveApplicant(applicantId: string, userId: string) {
  const applicant = await getApplicantById(applicantId);
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
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", applicantId)
    .select(APPLICANT_SELECT)
    .single();

  if (updateApplicantError) {
    throw new Error(updateApplicantError.message);
  }

  return {
    applicant: toApplicantDto(updatedApplicant as unknown as ApplicantRow),
    profile: toUserProfileCandidateDto(updatedProfile as unknown as UserProfileRow),
  };
}

// Backwards-compatible alias for the pre-approve naming.
export const linkApplicantToUserProfile = approveApplicant;

export async function rejectApplicant(applicantId: string) {
  const applicant = await getApplicantById(applicantId);
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
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", applicantId)
    .select(APPLICANT_SELECT)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return toApplicantDto(data as unknown as ApplicantRow);
}
