import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

export type WeekOrgResultStatus = "aggregating" | "reviewing" | "published";
// 부가 타임스탬프는 **선택 필드**다(2026-07-22 추가) — 기존 소비자(status/source 만 읽음)는 무영향.
//   source="legacy"(행 없음 폴백)일 때는 전부 null 이다(조직별 행이 없으므로 시각을 알 수 없음).
//   ⚠ 새 저장소가 아니라 기존 cluster4_week_org_result_states 행의 컬럼을 그대로 노출하는 것뿐이다.
export type WeekOrgResultState = {
  status: WeekOrgResultStatus;
  source: "organization" | "legacy";
  /** 조직별 검수 완료(공표) 시각 — status=published 로 전환한 시점. */
  publishedAt?: string | null;
  /** 검수 착수(reviewing) 시각. */
  reviewStartedAt?: string | null;
  /** 마지막 상태 전환 실행자(admin userId). */
  reviewedBy?: string | null;
  /** 마지막 상태 전환 시각. */
  updatedAt?: string | null;
};

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
    .select("week_id,status,published_at,review_started_at,reviewed_by,updated_at")
    .eq("organization_slug", organization).eq("scope", scope).in("week_id", weekIds);
  if (error) {
    console.warn("[week-org-result-state] read failed; legacy fallback", { organization, scope, message: error.message });
    return out;
  }
  for (const row of data ?? []) out.set(row.week_id as string, {
    status: row.status as WeekOrgResultStatus,
    source: "organization",
    publishedAt: (row.published_at as string | null) ?? null,
    reviewStartedAt: (row.review_started_at as string | null) ?? null,
    reviewedBy: (row.reviewed_by as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  });
  return out;
}

export function resolveWeekOrgResultState(row: WeekOrgResultState | undefined, start: string, legacyPublished: boolean): WeekOrgResultState {
  if (row) return row;
  // 폴백 경로는 조직별 행이 없다 → 타임스탬프는 전부 null(추측 값 생성 금지).
  const empty = { publishedAt: null, reviewStartedAt: null, reviewedBy: null, updatedAt: null };
  if (start < EFFECTIVE_FROM) {
    return { status: legacyPublished ? "published" : "aggregating", source: "legacy", ...empty };
  }
  return { status: "aggregating", source: "organization", ...empty };
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
