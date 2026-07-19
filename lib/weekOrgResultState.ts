import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

export type WeekOrgResultStatus = "aggregating" | "reviewing" | "published";
export type WeekOrgResultState = { status: WeekOrgResultStatus; source: "organization" | "legacy" };

// 검수 상태 scope — 운영 코호트 검수 / 테스트 코호트 검수는 서로 독립이다.
//   SoT = cluster4_week_org_result_states (week_id, organization_slug, scope).
//   같은 검수 흐름·같은 DTO·같은 snapshot 로직을 쓰되 대상 코호트(그리고 이 scope)만 다르다.
export type OrgResultScope = "operating" | "test";

const EFFECTIVE_FROM = "2026-06-29";

// 요청/코호트 mode → 검수 상태 scope. finalize 의 effMode 와 동일 규칙:
//   QA_HIDE_REAL_USERS(운영 화면이 테스터 모집단) 또는 mode∈{test,qa} → 'test', 그 외 'operating'.
//   ⚠ 카드 표시(computeWeeklyCards)는 이 함수가 아니라 "그 사용자의 test-marker 여부"로 scope 를 정한다
//     (사용자 단위 snapshot 이므로 대상 사용자 소속 코호트가 곧 scope). 관리자 화면/쓰기 경로에서만 사용.
export function resolveOrgResultScope(
  mode: "operating" | "test" | "qa" | null | undefined,
): OrgResultScope {
  if (QA_HIDE_REAL_USERS) return "test";
  return mode === "test" || mode === "qa" ? "test" : "operating";
}

export async function loadWeekOrgResultStates(
  weekIds: string[],
  organization: OrganizationSlug | null,
  scope: OrgResultScope,
) {
  const out = new Map<string, WeekOrgResultState>();
  if (!organization || weekIds.length === 0) return out;
  const { data, error } = await supabaseAdmin.from("cluster4_week_org_result_states")
    .select("week_id,status").eq("organization_slug", organization).eq("scope", scope).in("week_id", weekIds);
  if (error) {
    console.warn("[week-org-result-state] read failed; legacy fallback", { organization, scope, message: error.message });
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

export async function setWeekOrgResultStatus(
  weekId: string,
  organization: OrganizationSlug,
  scope: OrgResultScope,
  status: WeekOrgResultStatus,
  actor: string | null,
) {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin.from("cluster4_week_org_result_states").upsert({
    week_id: weekId, organization_slug: organization, scope, status,
    review_started_at: status === "aggregating" ? null : now,
    published_at: status === "published" ? now : null,
    reviewed_by: actor, updated_at: now,
  }, { onConflict: "week_id,organization_slug,scope" });
  if (error) throw new Error(`organization result state write failed: ${error.message}`);
}
