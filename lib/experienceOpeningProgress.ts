export type ExperienceOpeningProgress =
  | "required"
  | "application_completed"
  | "review_completed"
  | "opened";

export function resolveExperienceOpeningProgress(input: {
  opened: boolean;
  reviewCompleted?: boolean;
  applicationCompleted: boolean;
}): ExperienceOpeningProgress {
  if (input.opened) return "opened";
  if (input.reviewCompleted) return "review_completed";
  if (input.applicationCompleted) return "application_completed";
  return "required";
}
