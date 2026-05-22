// Browser-safe constants and types for the applicants admin view.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

export const APPLICANT_STATUSES = ["pending", "approved", "rejected"] as const;

export type ApplicantStatus = (typeof APPLICANT_STATUSES)[number];

export type AdminApplicantDto = {
  id: string;
  email: string | null;
  name: string | null;
  provider: string | null;
  status: ApplicantStatus;
  linkedUserId: string | null;
  // user_profiles.display_name of the linked user, enriched by the loader.
  // Null when no link exists or the linked profile was deleted.
  linkedDisplayName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type UserProfileCandidateDto = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
};

export function isApplicantStatus(value: string | null): value is ApplicantStatus {
  return Boolean(value && APPLICANT_STATUSES.includes(value as ApplicantStatus));
}
