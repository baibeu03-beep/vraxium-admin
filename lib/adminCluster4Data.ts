import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listReputationKeywords } from "@/lib/reputationKeywordsData";
import { listWeeklyReputations } from "@/lib/weeklyReputationsData";
import { listWeeklyReviews } from "@/lib/weeklyReviewsData";
import { listWeeklyColleagues } from "@/lib/weeklyColleaguesData";
import type {
  Cluster4ApplySummary,
  Cluster4Bundle,
  Cluster4DeleteResource,
  Cluster4PatchBody,
  ReceivedSeasonReputationRow,
  SeasonRow,
  UserSeasonHistoryRow,
  WeekRow,
} from "@/lib/adminCluster4Types";

export class Cluster4Error extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "Cluster4Error";
  }
}

type FetchResult<T> = { rows: T[]; available: boolean };

async function resolveUserId(routeParam: string): Promise<string | null> {
  const id = String(routeParam).trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", id)
    .maybeSingle();

  if (error) {
    console.error("[cluster4] query failed (user_profiles lookup)", {
      routeParam: id,
      message: error.message,
    });
    throw new Cluster4Error(500, error.message);
  }

  return (data as { user_id?: string } | null)?.user_id ?? null;
}

function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return typeof error.message === "string" && /does not exist/i.test(error.message);
}

function handleResult<T>(
  table: string,
  data: unknown,
  error: { code?: string; message?: string } | null,
): FetchResult<T> {
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(`[cluster4] table "${table}" not found; returning empty result.`, {
        message: error.message,
      });
      return { rows: [], available: false };
    }
    console.error(`[cluster4] query failed (${table})`, { message: error.message });
    throw new Cluster4Error(500, error.message ?? `Failed to query ${table}`);
  }

  return { rows: (Array.isArray(data) ? data : []) as T[], available: true };
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = typeof value === "string" ? value : String(value);
  const trimmed = stringValue.trim();
  return trimmed === "" ? null : trimmed;
}

const SEASON_REPUTATION_RATING_MESSAGE =
  "rating 은 1~10 사이 0.5 단위 숫자여야 합니다.";
const SEASON_REPUTATION_CONTENT_MESSAGE =
  "content 는 1~300 자여야 합니다.";
const SEASON_REPUTATION_KEYWORD_LENGTH_MESSAGE =
  "keyword_1/2/3 은 각각 1~10 자여야 합니다.";
const SEASON_REPUTATION_KEYWORD_DISTINCT_MESSAGE =
  "keyword_1/2/3 은 모두 서로 다른 값이어야 합니다.";

function normalizeSeasonReputationRating(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n < 1 || n > 10 || (n * 2) !== Math.floor(n * 2)) {
    throw new Cluster4Error(400, SEASON_REPUTATION_RATING_MESSAGE);
  }
  return n;
}

function normalizeSeasonReputationContent(value: unknown): string {
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  const trimmed = stringValue.trim();
  if (trimmed.length < 1 || trimmed.length > 300) {
    throw new Cluster4Error(400, SEASON_REPUTATION_CONTENT_MESSAGE);
  }
  return trimmed;
}

function normalizeSeasonReputationKeyword(value: unknown): string {
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  const trimmed = stringValue.trim();
  if (trimmed.length < 1 || trimmed.length > 10) {
    throw new Cluster4Error(400, SEASON_REPUTATION_KEYWORD_LENGTH_MESSAGE);
  }
  return trimmed;
}

const WEEKLY_REPUTATION_RATING_MESSAGE =
  "rating 은 0~10 사이 0.5 단위 숫자여야 합니다.";
const WEEKLY_REPUTATION_CONTENT_MESSAGE =
  "content 는 1~100 자여야 합니다.";
const WEEKLY_REPUTATION_KEYWORD_MESSAGE =
  "keyword 는 1~30 자여야 합니다.";

function normalizeWeeklyReputationRating(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n < 0 || n > 10 || (n * 2) !== Math.floor(n * 2)) {
    throw new Cluster4Error(400, WEEKLY_REPUTATION_RATING_MESSAGE);
  }
  return n;
}

function normalizeWeeklyReputationContent(value: unknown): string {
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  const trimmed = stringValue.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new Cluster4Error(400, WEEKLY_REPUTATION_CONTENT_MESSAGE);
  }
  return trimmed;
}

function normalizeWeeklyReputationKeyword(value: unknown): string {
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  const trimmed = stringValue.trim();
  if (trimmed.length < 1 || trimmed.length > 30) {
    throw new Cluster4Error(400, WEEKLY_REPUTATION_KEYWORD_MESSAGE);
  }
  return trimmed;
}

const WEEKLY_REVIEW_RATING_MESSAGE =
  "평점은 1~10 사이의 정수로 입력해주세요.";
const WEEKLY_REVIEW_CONTENT_MESSAGE = "내용은 1~200 자여야 합니다.";

function normalizeWeeklyReviewRating(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 1 ||
    n > 10
  ) {
    throw new Cluster4Error(400, WEEKLY_REVIEW_RATING_MESSAGE);
  }
  return n;
}

function normalizeWeeklyReviewContent(value: unknown): string {
  const stringValue = typeof value === "string" ? value : String(value ?? "");
  const trimmed = stringValue.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new Cluster4Error(400, WEEKLY_REVIEW_CONTENT_MESSAGE);
  }
  return trimmed;
}

const WEEKLY_COLLEAGUE_RANK_MESSAGE = "rank 는 1~3 사이의 정수여야 합니다.";
const WEEKLY_COLLEAGUE_MESSAGE_MESSAGE =
  "한 줄 코멘트는 비워두거나 1~200 자여야 합니다.";

function normalizeWeeklyColleagueRank(value: unknown): number {
  const n =
    typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 1 ||
    n > 3
  ) {
    throw new Cluster4Error(400, WEEKLY_COLLEAGUE_RANK_MESSAGE);
  }
  return n;
}

function normalizeWeeklyColleagueMessage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = typeof value === "string" ? value : String(value);
  const trimmed = stringValue.trim();
  if (trimmed === "") return null;
  if (trimmed.length > 200) {
    throw new Cluster4Error(400, WEEKLY_COLLEAGUE_MESSAGE_MESSAGE);
  }
  return trimmed;
}

const USER_SEASON_HISTORY_RATING_MESSAGE =
  "평점은 0~10 사이의 정수로 입력해주세요.";

function normalizeUserSeasonHistoryRating(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n =
    typeof value === "number" ? value : Number(String(value).trim());
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < 0 ||
    n > 10
  ) {
    throw new Cluster4Error(400, USER_SEASON_HISTORY_RATING_MESSAGE);
  }
  return n;
}

async function fetchReceivedSeasonReputations(
  targetUserId: string,
): Promise<FetchResult<ReceivedSeasonReputationRow>> {
  const { data, error } = await supabaseAdmin
    .from("season_reputations")
    .select(
      "id, reviewer_id, target_user_id, season_history_id, rating, content, keyword_1, keyword_2, keyword_3, created_at, updated_at",
    )
    .eq("target_user_id", targetUserId)
    .order("created_at", { ascending: true });

  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(
        '[cluster4] table "season_reputations" not found; returning empty result.',
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[cluster4] query failed (season_reputations)", {
      message: error.message,
    });
    throw new Cluster4Error(500, error.message);
  }

  const rawRows = (Array.isArray(data) ? data : []) as Array<{
    id: string;
    reviewer_id: string;
    target_user_id: string;
    season_history_id: string | null;
    rating: number | null;
    content: string | null;
    keyword_1: string | null;
    keyword_2: string | null;
    keyword_3: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>;

  if (rawRows.length === 0) {
    return { rows: [], available: true };
  }

  const reviewerIds = Array.from(new Set(rawRows.map((r) => r.reviewer_id)));
  const { data: reviewerData, error: reviewerError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, organization_slug")
    .in("user_id", reviewerIds);

  if (reviewerError) {
    console.error("[cluster4] query failed (user_profiles for reviewers)", {
      message: reviewerError.message,
    });
    throw new Cluster4Error(500, reviewerError.message);
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

  const rows: ReceivedSeasonReputationRow[] = rawRows.map((row) => ({
    ...row,
    reviewer: reviewerMap.get(row.reviewer_id) ?? null,
  }));

  return { rows, available: true };
}

async function fetchCluster4Tables(userId: string) {
  const [
    seasonsRaw,
    weeksRaw,
    historiesRaw,
    receivedReputations,
    reputationKeywords,
    weeklyReputations,
    weeklyReviews,
    weeklyColleagues,
  ] = await Promise.all([
    supabaseAdmin.from("seasons").select("*"),
    supabaseAdmin.from("weeks").select("*"),
    supabaseAdmin.from("user_season_histories").select("*").eq("user_id", userId),
    fetchReceivedSeasonReputations(userId),
    listReputationKeywords(),
    listWeeklyReputations({ targetUserId: userId }),
    listWeeklyReviews({ userId }),
    listWeeklyColleagues({ userId }),
  ]);

  return {
    seasons: handleResult<SeasonRow>("seasons", seasonsRaw.data, seasonsRaw.error),
    weeks: handleResult<WeekRow>("weeks", weeksRaw.data, weeksRaw.error),
    userSeasonHistories: handleResult<UserSeasonHistoryRow>(
      "user_season_histories",
      historiesRaw.data,
      historiesRaw.error,
    ),
    receivedSeasonReputations: receivedReputations,
    reputationKeywords,
    weeklyReputations,
    weeklyReviews,
    weeklyColleagues,
  };
}

export async function getCluster4ForCrew(
  legacyUserId: string,
): Promise<Cluster4Bundle> {
  const userId = await resolveUserId(legacyUserId);

  if (!userId) {
    return {
      legacyUserId,
      userId: null,
      seasons: [],
      weeks: [],
      userSeasonHistories: [],
      receivedSeasonReputations: [],
      reputationKeywords: [],
      receivedWeeklyReputations: [],
      weeklyReviews: [],
      weeklyColleagues: [],
      tablesAvailable: {
        seasons: false,
        weeks: false,
        userSeasonHistories: false,
        seasonReputations: false,
        reputationKeywords: false,
        weeklyReputations: false,
        weeklyReviews: false,
        weeklyColleagues: false,
      },
    };
  }

  const tables = await fetchCluster4Tables(userId);

  return {
    legacyUserId,
    userId,
    seasons: tables.seasons.rows,
    weeks: tables.weeks.rows,
    userSeasonHistories: tables.userSeasonHistories.rows,
    receivedSeasonReputations: tables.receivedSeasonReputations.rows,
    reputationKeywords: tables.reputationKeywords.rows,
    receivedWeeklyReputations: tables.weeklyReputations.rows,
    weeklyReviews: tables.weeklyReviews.rows,
    weeklyColleagues: tables.weeklyColleagues.rows,
    tablesAvailable: {
      seasons: tables.seasons.available,
      weeks: tables.weeks.available,
      userSeasonHistories: tables.userSeasonHistories.available,
      seasonReputations: tables.receivedSeasonReputations.available,
      reputationKeywords: tables.reputationKeywords.available,
      weeklyReputations: tables.weeklyReputations.available,
      weeklyReviews: tables.weeklyReviews.available,
      weeklyColleagues: tables.weeklyColleagues.available,
    },
  };
}

export async function patchCluster4ForCrew(
  legacyUserId: string,
  body: Cluster4PatchBody,
): Promise<{
  bundle: Cluster4Bundle;
  warnings: string[];
  applied: Cluster4ApplySummary;
}> {
  const userId = await resolveUserId(legacyUserId);
  if (!userId) {
    throw new Cluster4Error(409, "Crew is not linked to user_profiles.");
  }

  const warnings: string[] = [];
  const applied: Cluster4ApplySummary = {};

  if (body.userSeasonHistories !== undefined) {
    if (!Array.isArray(body.userSeasonHistories)) {
      throw new Cluster4Error(400, "userSeasonHistories must be an array.");
    }

    const ids = body.userSeasonHistories.map((row) =>
      String(row?.id ?? "").trim(),
    );
    if (ids.some((id) => !id)) {
      throw new Cluster4Error(400, "Each userSeasonHistories row must include id.");
    }

    for (const row of body.userSeasonHistories) {
      normalizeUserSeasonHistoryRating(row.rating);
    }

    const uniqueIds = [...new Set(ids)];
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from("user_season_histories")
      .select("id")
      .eq("user_id", userId)
      .in("id", uniqueIds);

    if (existingError) {
      console.error("[cluster4] query failed (user_season_histories validate)", {
        message: existingError.message,
      });
      throw new Cluster4Error(500, existingError.message);
    }

    const existingIdSet = new Set(
      ((existingRows ?? []) as Array<{ id?: string | number | null }>)
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean),
    );

    for (const row of body.userSeasonHistories) {
      const id = String(row.id).trim();
      if (!existingIdSet.has(id)) {
        warnings.push(`Skipped user_season_histories row ${id}: not found for this user.`);
        continue;
      }

      const patch = {
        rating: normalizeUserSeasonHistoryRating(row.rating),
        review: normalizeNullableString(row.review),
      };

      const { error } = await supabaseAdmin
        .from("user_season_histories")
        .update(patch)
        .eq("user_id", userId)
        .eq("id", id);

      if (error) {
        console.error("[cluster4] query failed (update user_season_histories)", {
          id,
          message: error.message,
        });
        if (
          error.message &&
          /user_season_histories_rating_check/i.test(error.message)
        ) {
          throw new Cluster4Error(400, USER_SEASON_HISTORY_RATING_MESSAGE);
        }
        throw new Cluster4Error(500, error.message);
      }
    }

    applied.userSeasonHistories = {
      updated: uniqueIds.filter((id) => existingIdSet.has(id)).length,
      ids: uniqueIds.filter((id) => existingIdSet.has(id)),
    };
  }

  if (body.seasonReputations !== undefined) {
    if (!Array.isArray(body.seasonReputations)) {
      throw new Cluster4Error(400, "seasonReputations must be an array.");
    }

    const ids = body.seasonReputations.map((row) =>
      String(row?.id ?? "").trim(),
    );
    if (ids.some((id) => !id)) {
      throw new Cluster4Error(400, "Each seasonReputations row must include id.");
    }

    const normalized = body.seasonReputations.map((row) => {
      const k1 = normalizeSeasonReputationKeyword(row.keyword_1);
      const k2 = normalizeSeasonReputationKeyword(row.keyword_2);
      const k3 = normalizeSeasonReputationKeyword(row.keyword_3);
      if (k1 === k2 || k2 === k3 || k1 === k3) {
        throw new Cluster4Error(400, SEASON_REPUTATION_KEYWORD_DISTINCT_MESSAGE);
      }
      return {
        id: String(row.id).trim(),
        rating: normalizeSeasonReputationRating(row.rating),
        content: normalizeSeasonReputationContent(row.content),
        keyword_1: k1,
        keyword_2: k2,
        keyword_3: k3,
      };
    });

    const uniqueIds = [...new Set(ids)];
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from("season_reputations")
      .select("id")
      .eq("target_user_id", userId)
      .in("id", uniqueIds);

    if (existingError) {
      console.error("[cluster4] query failed (season_reputations validate)", {
        message: existingError.message,
      });
      throw new Cluster4Error(500, existingError.message);
    }

    const existingIdSet = new Set(
      ((existingRows ?? []) as Array<{ id?: string | null }>)
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean),
    );

    for (const row of normalized) {
      if (!existingIdSet.has(row.id)) {
        warnings.push(
          `Skipped season_reputations row ${row.id}: not found for this target_user_id.`,
        );
        continue;
      }

      const { error } = await supabaseAdmin
        .from("season_reputations")
        .update({
          rating: row.rating,
          content: row.content,
          keyword_1: row.keyword_1,
          keyword_2: row.keyword_2,
          keyword_3: row.keyword_3,
        })
        .eq("id", row.id)
        .eq("target_user_id", userId);

      if (error) {
        console.error("[cluster4] query failed (update season_reputations)", {
          id: row.id,
          message: error.message,
        });
        if (error.message) {
          if (/season_reputations_rating_range_half_step/i.test(error.message)) {
            throw new Cluster4Error(400, SEASON_REPUTATION_RATING_MESSAGE);
          }
          if (/season_reputations_content_length/i.test(error.message)) {
            throw new Cluster4Error(400, SEASON_REPUTATION_CONTENT_MESSAGE);
          }
          if (
            /season_reputations_keyword_(1|2|3)_length/i.test(error.message)
          ) {
            throw new Cluster4Error(
              400,
              SEASON_REPUTATION_KEYWORD_LENGTH_MESSAGE,
            );
          }
          if (/season_reputations_distinct_keywords/i.test(error.message)) {
            throw new Cluster4Error(
              400,
              SEASON_REPUTATION_KEYWORD_DISTINCT_MESSAGE,
            );
          }
        }
        throw new Cluster4Error(500, error.message);
      }
    }

    const appliedIds = normalized
      .filter((row) => existingIdSet.has(row.id))
      .map((row) => row.id);
    applied.seasonReputations = {
      updated: appliedIds.length,
      ids: appliedIds,
    };
  }

  if (body.weeklyReputations !== undefined) {
    if (!Array.isArray(body.weeklyReputations)) {
      throw new Cluster4Error(400, "weeklyReputations must be an array.");
    }

    const ids = body.weeklyReputations.map((row) =>
      String(row?.id ?? "").trim(),
    );
    if (ids.some((id) => !id)) {
      throw new Cluster4Error(400, "Each weeklyReputations row must include id.");
    }

    const normalized = body.weeklyReputations.map((row) => ({
      id: String(row.id).trim(),
      rating: normalizeWeeklyReputationRating(row.rating),
      content: normalizeWeeklyReputationContent(row.content),
      keyword: normalizeWeeklyReputationKeyword(row.keyword),
    }));

    const uniqueIds = [...new Set(ids)];
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from("weekly_reputations")
      .select("id")
      .eq("target_user_id", userId)
      .in("id", uniqueIds);

    if (existingError) {
      console.error("[cluster4] query failed (weekly_reputations validate)", {
        message: existingError.message,
      });
      throw new Cluster4Error(500, existingError.message);
    }

    const existingIdSet = new Set(
      ((existingRows ?? []) as Array<{ id?: string | null }>)
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean),
    );

    for (const row of normalized) {
      if (!existingIdSet.has(row.id)) {
        warnings.push(
          `Skipped weekly_reputations row ${row.id}: not found for this target_user_id.`,
        );
        continue;
      }

      const { error } = await supabaseAdmin
        .from("weekly_reputations")
        .update({
          rating: row.rating,
          content: row.content,
          keyword: row.keyword,
        })
        .eq("id", row.id)
        .eq("target_user_id", userId);

      if (error) {
        console.error("[cluster4] query failed (update weekly_reputations)", {
          id: row.id,
          message: error.message,
        });
        if (error.message) {
          if (/weekly_reputations_rating_range_half_step/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_REPUTATION_RATING_MESSAGE);
          }
          if (/weekly_reputations_content_length/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_REPUTATION_CONTENT_MESSAGE);
          }
          if (/weekly_reputations_keyword_nonempty/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_REPUTATION_KEYWORD_MESSAGE);
          }
        }
        throw new Cluster4Error(500, error.message);
      }
    }

    const appliedIds = normalized
      .filter((row) => existingIdSet.has(row.id))
      .map((row) => row.id);
    applied.weeklyReputations = {
      updated: appliedIds.length,
      ids: appliedIds,
    };
  }

  if (body.weeklyReviews !== undefined) {
    if (!Array.isArray(body.weeklyReviews)) {
      throw new Cluster4Error(400, "weeklyReviews must be an array.");
    }

    const ids = body.weeklyReviews.map((row) =>
      String(row?.id ?? "").trim(),
    );
    if (ids.some((id) => !id)) {
      throw new Cluster4Error(400, "Each weeklyReviews row must include id.");
    }

    const normalized = body.weeklyReviews.map((row) => ({
      id: String(row.id).trim(),
      rating: normalizeWeeklyReviewRating(row.rating),
      content: normalizeWeeklyReviewContent(row.content),
    }));

    const uniqueIds = [...new Set(ids)];
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from("weekly_reviews")
      .select("id")
      .eq("user_id", userId)
      .in("id", uniqueIds);

    if (existingError) {
      console.error("[cluster4] query failed (weekly_reviews validate)", {
        message: existingError.message,
      });
      throw new Cluster4Error(500, existingError.message);
    }

    const existingIdSet = new Set(
      ((existingRows ?? []) as Array<{ id?: string | null }>)
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean),
    );

    for (const row of normalized) {
      if (!existingIdSet.has(row.id)) {
        warnings.push(
          `Skipped weekly_reviews row ${row.id}: not found for this user.`,
        );
        continue;
      }

      const { error } = await supabaseAdmin
        .from("weekly_reviews")
        .update({ rating: row.rating, content: row.content })
        .eq("id", row.id)
        .eq("user_id", userId);

      if (error) {
        console.error("[cluster4] query failed (update weekly_reviews)", {
          id: row.id,
          message: error.message,
        });
        if (error.message) {
          if (/weekly_reviews_rating_range/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_REVIEW_RATING_MESSAGE);
          }
          if (/weekly_reviews_content_length/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_REVIEW_CONTENT_MESSAGE);
          }
        }
        throw new Cluster4Error(500, error.message);
      }
    }

    const appliedIds = normalized
      .filter((row) => existingIdSet.has(row.id))
      .map((row) => row.id);
    applied.weeklyReviews = {
      updated: appliedIds.length,
      ids: appliedIds,
    };
  }

  if (body.weeklyColleagues !== undefined) {
    if (!Array.isArray(body.weeklyColleagues)) {
      throw new Cluster4Error(400, "weeklyColleagues must be an array.");
    }

    const ids = body.weeklyColleagues.map((row) =>
      String(row?.id ?? "").trim(),
    );
    if (ids.some((id) => !id)) {
      throw new Cluster4Error(400, "Each weeklyColleagues row must include id.");
    }

    const normalized = body.weeklyColleagues.map((row) => ({
      id: String(row.id).trim(),
      rank: normalizeWeeklyColleagueRank(row.rank),
      message: normalizeWeeklyColleagueMessage(row.message),
    }));

    const uniqueIds = [...new Set(ids)];
    const { data: existingRows, error: existingError } = await supabaseAdmin
      .from("weekly_colleagues")
      .select("id")
      .eq("user_id", userId)
      .in("id", uniqueIds);

    if (existingError) {
      console.error("[cluster4] query failed (weekly_colleagues validate)", {
        message: existingError.message,
      });
      throw new Cluster4Error(500, existingError.message);
    }

    const existingIdSet = new Set(
      ((existingRows ?? []) as Array<{ id?: string | null }>)
        .map((row) => String(row.id ?? "").trim())
        .filter(Boolean),
    );

    for (const row of normalized) {
      if (!existingIdSet.has(row.id)) {
        warnings.push(
          `Skipped weekly_colleagues row ${row.id}: not found for this user.`,
        );
        continue;
      }

      const { error } = await supabaseAdmin
        .from("weekly_colleagues")
        .update({ rank: row.rank, message: row.message })
        .eq("id", row.id)
        .eq("user_id", userId);

      if (error) {
        console.error("[cluster4] query failed (update weekly_colleagues)", {
          id: row.id,
          message: error.message,
        });
        if (error.message) {
          if (/weekly_colleagues_rank_range/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_COLLEAGUE_RANK_MESSAGE);
          }
          if (/weekly_colleagues_message_length/i.test(error.message)) {
            throw new Cluster4Error(400, WEEKLY_COLLEAGUE_MESSAGE_MESSAGE);
          }
        }
        throw new Cluster4Error(500, error.message);
      }
    }

    const appliedIds = normalized
      .filter((row) => existingIdSet.has(row.id))
      .map((row) => row.id);
    applied.weeklyColleagues = {
      updated: appliedIds.length,
      ids: appliedIds,
    };
  }

  const bundle = await getCluster4ForCrew(legacyUserId);
  return { bundle, warnings, applied };
}

type DeleteSpec = {
  table: string;
  // user-scoped column used to enforce ownership. season_reputations / weekly_reputations
  // 의 경우 target_user_id 로, weekly_reviews / weekly_colleagues 는 user_id.
  scopeColumn: "target_user_id" | "user_id";
  notFoundMessage: string;
  outOfScopeMessage: string;
};

const DELETE_SPECS: Record<Cluster4DeleteResource, DeleteSpec> = {
  seasonReputation: {
    table: "season_reputations",
    scopeColumn: "target_user_id",
    notFoundMessage: "Season reputation not found.",
    outOfScopeMessage: "Season reputation does not belong to this crew.",
  },
  weeklyReputation: {
    table: "weekly_reputations",
    scopeColumn: "target_user_id",
    notFoundMessage: "Weekly reputation not found.",
    outOfScopeMessage: "Weekly reputation does not belong to this crew.",
  },
  weeklyReview: {
    table: "weekly_reviews",
    scopeColumn: "user_id",
    notFoundMessage: "Weekly review not found.",
    outOfScopeMessage: "Weekly review does not belong to this crew.",
  },
  weeklyColleague: {
    table: "weekly_colleagues",
    scopeColumn: "user_id",
    notFoundMessage: "Weekly colleague not found.",
    outOfScopeMessage: "Weekly colleague does not belong to this crew.",
  },
};

export async function deleteCluster4Resource(
  legacyUserId: string,
  resource: Cluster4DeleteResource,
  rowId: string,
): Promise<{ bundle: Cluster4Bundle; deletedId: string }> {
  const userId = await resolveUserId(legacyUserId);
  if (!userId) {
    throw new Cluster4Error(409, "Crew is not linked to user_profiles.");
  }

  const id = String(rowId ?? "").trim();
  if (!id) {
    throw new Cluster4Error(400, `${resource} id is required.`);
  }

  const spec = DELETE_SPECS[resource];
  if (!spec) {
    throw new Cluster4Error(400, `Unknown resource: ${resource}`);
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from(spec.table)
    .select(`id, ${spec.scopeColumn}`)
    .eq("id", id)
    .maybeSingle();

  if (existingError) {
    if (isMissingRelationError(existingError)) {
      throw new Cluster4Error(404, spec.notFoundMessage);
    }
    console.error(`[cluster4] query failed (${spec.table} lookup for delete)`, {
      message: existingError.message,
    });
    throw new Cluster4Error(500, existingError.message);
  }

  if (!existing) {
    throw new Cluster4Error(404, spec.notFoundMessage);
  }

  if (
    (existing as Record<string, unknown>)[spec.scopeColumn] !== userId
  ) {
    throw new Cluster4Error(403, spec.outOfScopeMessage);
  }

  const { error: deleteError } = await supabaseAdmin
    .from(spec.table)
    .delete()
    .eq("id", id)
    .eq(spec.scopeColumn, userId);

  if (deleteError) {
    console.error(`[cluster4] query failed (delete ${spec.table})`, {
      id,
      message: deleteError.message,
    });
    throw new Cluster4Error(500, deleteError.message);
  }

  const bundle = await getCluster4ForCrew(legacyUserId);
  return { bundle, deletedId: id };
}

// Backwards-compatible name kept exported for callers that still import it.
export async function deleteSeasonReputationForCrew(
  legacyUserId: string,
  seasonReputationId: string,
): Promise<{ bundle: Cluster4Bundle; deletedId: string }> {
  return deleteCluster4Resource(
    legacyUserId,
    "seasonReputation",
    seasonReputationId,
  );
}
