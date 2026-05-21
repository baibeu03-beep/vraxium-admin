// Server-only data layer for weekly_colleagues (주차별 연계 동료).
// Admin 운영 화면에서 사용. user-facing API 는 별도 (Front repo).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type {
  WeeklyColleagueRow,
  WeeklyColleaguesListOptions,
  WeeklyColleaguesListResult,
} from "@/lib/weeklyColleaguesTypes";

const SELECT_COLUMNS =
  "id,user_id,week_card_id,colleague_id,rank,message,created_at,updated_at";

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

export async function listWeeklyColleagues(
  options: WeeklyColleaguesListOptions,
): Promise<WeeklyColleaguesListResult> {
  const userId = String(options.userId ?? "").trim();
  if (!userId) {
    throw new Error("listWeeklyColleagues: userId is required.");
  }

  let query = supabaseAdmin
    .from("weekly_colleagues")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("week_card_id", { ascending: true })
    .order("rank", { ascending: true });

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
        "[weekly_colleagues] table not found; returning empty result.",
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[weekly_colleagues] query failed", {
      message: error.message,
    });
    throw new Error(error.message);
  }

  const rawRows = ((data ?? []) as Record<string, unknown>[]).map((raw) => ({
    id: String(raw.id ?? ""),
    user_id: String(raw.user_id ?? ""),
    week_card_id: String(raw.week_card_id ?? ""),
    colleague_id: String(raw.colleague_id ?? ""),
    rank: toNumber(raw.rank),
    message:
      typeof raw.message === "string"
        ? raw.message
        : raw.message === null
          ? null
          : null,
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  }));

  if (rawRows.length === 0) {
    return { rows: [], available: true };
  }

  const colleagueIds = Array.from(
    new Set(rawRows.map((r) => r.colleague_id).filter(Boolean)),
  );
  const { data: colleagueData, error: colleagueError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, organization_slug")
    .in("user_id", colleagueIds);

  if (colleagueError) {
    console.error(
      "[weekly_colleagues] query failed (user_profiles for colleagues)",
      { message: colleagueError.message },
    );
    throw new Error(colleagueError.message);
  }

  const colleagueMap = new Map<
    string,
    { user_id: string; display_name: string | null; organization_slug: string | null }
  >();
  for (const row of (colleagueData ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  }>) {
    colleagueMap.set(row.user_id, row);
  }

  const rows: WeeklyColleagueRow[] = rawRows.map((row) => ({
    ...row,
    colleague: colleagueMap.get(row.colleague_id) ?? null,
  }));

  return { rows, available: true };
}
