import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

export type WeekOrgResultStatus = "aggregating" | "reviewing" | "published";
export type WeekOrgResultState = { status: WeekOrgResultStatus; source: "organization" | "legacy" };
const EFFECTIVE_FROM = "2026-06-29";

export async function loadWeekOrgResultStates(weekIds: string[], organization: OrganizationSlug | null) {
  const out = new Map<string, WeekOrgResultState>();
  if (!organization || weekIds.length === 0) return out;
  const { data, error } = await supabaseAdmin.from("cluster4_week_org_result_states")
    .select("week_id,status").eq("organization_slug", organization).in("week_id", weekIds);
  if (error) {
    console.warn("[week-org-result-state] read failed; legacy fallback", { organization, message: error.message });
    return out;
  }
  for (const row of data ?? []) out.set(row.week_id as string, {
    status: row.status as WeekOrgResultStatus, source: "organization",
  });
  return out;
}

export function resolveWeekOrgResultState(row: WeekOrgResultState | undefined, start: string, legacyPublished: boolean): WeekOrgResultState {
  if (row) return row;
  if (start < EFFECTIVE_FROM) return { status: legacyPublished ? "published" : "aggregating", source: "legacy" };
  return { status: "aggregating", source: "organization" };
}

export async function setWeekOrgResultStatus(weekId: string, organization: OrganizationSlug, status: WeekOrgResultStatus, actor: string | null) {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("cluster4_week_org_result_states").upsert({
    week_id: weekId, organization_slug: organization, status,
    review_started_at: status === "aggregating" ? null : now,
    published_at: status === "published" ? now : null,
    reviewed_by: actor, updated_at: now,
  }, { onConflict: "week_id,organization_slug" });
  if (error) throw new Error(`organization result state write failed: ${error.message}`);
}
