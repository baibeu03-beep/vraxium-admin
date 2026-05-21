// Server-only data layer for weekly_reputations (peer-review row).
//
// Both /api/weekly-reputations (route handler) and the admin Cluster4 bundle
// (lib/adminCluster4Data.ts) reuse this — admin 경로는 HTTP roundtrip 없이
// 같은 함수를 직접 호출한다.
//
// Admin: target_user_id = 현재 관리 중인 user 인 row 만 표시 (받은 주간 평판).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  WeeklyReputationRow,
  WeeklyReputationsListOptions,
  WeeklyReputationsListResult,
} from "@/lib/weeklyReputationsTypes";

const SELECT_COLUMNS =
  "id,reviewer_id,target_user_id,week_card_id,rating,content,keyword,created_at,updated_at";

function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return (
    typeof error.message === "string" && /does not exist/i.test(error.message)
  );
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function listWeeklyReputations(
  options: WeeklyReputationsListOptions,
): Promise<WeeklyReputationsListResult> {
  const targetUserId = String(options.targetUserId ?? "").trim();
  if (!targetUserId) {
    throw new Error("listWeeklyReputations: targetUserId is required.");
  }

  let query = supabaseAdmin
    .from("weekly_reputations")
    .select(SELECT_COLUMNS)
    .eq("target_user_id", targetUserId)
    .order("created_at", { ascending: true });

  const weekCardId = options.weekCardId
    ? String(options.weekCardId).trim()
    : "";
  if (weekCardId) {
    query = query.eq("week_card_id", weekCardId);
  }

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(
        "[weekly_reputations] table not found; returning empty result.",
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[weekly_reputations] query failed", {
      message: error.message,
    });
    throw new Error(error.message);
  }

  const rawRows = ((data ?? []) as Record<string, unknown>[]).map((raw) => ({
    id: String(raw.id ?? ""),
    reviewer_id: String(raw.reviewer_id ?? ""),
    target_user_id: String(raw.target_user_id ?? ""),
    week_card_id: String(raw.week_card_id ?? ""),
    rating: toNumber(raw.rating),
    content: typeof raw.content === "string" ? raw.content : "",
    keyword: typeof raw.keyword === "string" ? raw.keyword : "",
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  }));

  if (rawRows.length === 0) {
    return { rows: [], available: true };
  }

  // reviewer display_name / organization_slug 를 한 번에 조회.
  const reviewerIds = Array.from(new Set(rawRows.map((r) => r.reviewer_id)));
  const { data: reviewerData, error: reviewerError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, organization_slug")
    .in("user_id", reviewerIds);

  if (reviewerError) {
    console.error(
      "[weekly_reputations] query failed (user_profiles for reviewers)",
      { message: reviewerError.message },
    );
    throw new Error(reviewerError.message);
  }

  const reviewerMap = new Map<
    string,
    { user_id: string; display_name: string | null; organization_slug: string | null }
  >();
  for (const row of (reviewerData ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  }>) {
    reviewerMap.set(row.user_id, row);
  }

  const rows: WeeklyReputationRow[] = rawRows.map((row) => ({
    ...row,
    reviewer: reviewerMap.get(row.reviewer_id) ?? null,
  }));

  return { rows, available: true };
}
