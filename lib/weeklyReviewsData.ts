// Server-only data layer for weekly_reviews (주차별 본인 회고).
// Admin 운영 화면에서 사용. user-facing API 는 별도 (Front repo).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  WeeklyReviewRow,
  WeeklyReviewsListOptions,
  WeeklyReviewsListResult,
} from "@/lib/weeklyReviewsTypes";

const SELECT_COLUMNS =
  "id,user_id,week_card_id,rating,content,created_at,updated_at";

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

function normalizeRow(raw: Record<string, unknown>): WeeklyReviewRow {
  return {
    id: String(raw.id ?? ""),
    user_id: String(raw.user_id ?? ""),
    week_card_id: String(raw.week_card_id ?? ""),
    rating: toNumber(raw.rating),
    content: typeof raw.content === "string" ? raw.content : "",
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

export async function listWeeklyReviews(
  options: WeeklyReviewsListOptions,
): Promise<WeeklyReviewsListResult> {
  const userId = String(options.userId ?? "").trim();
  if (!userId) {
    throw new Error("listWeeklyReviews: userId is required.");
  }

  let query = supabaseAdmin
    .from("weekly_reviews")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
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
        "[weekly_reviews] table not found; returning empty result.",
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[weekly_reviews] query failed", { message: error.message });
    throw new Error(error.message);
  }

  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeRow);
  return { rows, available: true };
}
