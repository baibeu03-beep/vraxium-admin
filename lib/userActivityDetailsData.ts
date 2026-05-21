// Server-only data layer for user_activity_details (Cluster4-card 활동 모달).
// Admin Cluster4Editor 에서 사용. user-facing API 는 Career-Resume repo 별도.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  classifyActivityType,
  type UserActivityDetailRow,
  type UserActivityDetailUpsertInput,
  type UserActivityDetailsListOptions,
  type UserActivityDetailsListResult,
  type UserActivityModalKey,
  type UserActivityOutputLink,
} from "@/lib/userActivityDetailsTypes";

const SELECT_COLUMNS =
  "id,user_id,week_id,activity_type_id,sub_title,output_links,growth_point,image_urls,image_captions,growth_image_url,growth_image_caption,rating,created_at,updated_at";

function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return (
    typeof error.message === "string" && /does not exist/i.test(error.message)
  );
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : null))
    .filter((entry): entry is string => entry !== null);
}

function toOutputLinks(value: unknown): UserActivityOutputLink[] {
  if (!Array.isArray(value)) return [];
  const rows: UserActivityOutputLink[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : null;
      if (!url) continue;
      const desc = typeof record.desc === "string" ? record.desc : null;
      rows.push({ desc, url });
    }
  }
  return rows;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(raw: Record<string, unknown>): UserActivityDetailRow {
  return {
    id: String(raw.id ?? ""),
    user_id: String(raw.user_id ?? ""),
    week_id: String(raw.week_id ?? ""),
    activity_type_id: String(raw.activity_type_id ?? ""),
    sub_title:
      typeof raw.sub_title === "string" && raw.sub_title.trim() !== ""
        ? raw.sub_title
        : null,
    output_links: toOutputLinks(raw.output_links),
    growth_point:
      typeof raw.growth_point === "string" && raw.growth_point.trim() !== ""
        ? raw.growth_point
        : null,
    image_urls: toStringArray(raw.image_urls),
    image_captions: toStringArray(raw.image_captions),
    growth_image_url:
      typeof raw.growth_image_url === "string" && raw.growth_image_url.trim() !== ""
        ? raw.growth_image_url
        : null,
    growth_image_caption:
      typeof raw.growth_image_caption === "string" &&
      raw.growth_image_caption.trim() !== ""
        ? raw.growth_image_caption
        : null,
    rating: toNullableNumber(raw.rating),
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

export async function listUserActivityDetails(
  options: UserActivityDetailsListOptions,
): Promise<UserActivityDetailsListResult> {
  const userId = String(options.userId ?? "").trim();
  if (!userId) {
    throw new Error("listUserActivityDetails: userId is required.");
  }

  let query = supabaseAdmin
    .from("user_activity_details")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("week_id", { ascending: true })
    .order("activity_type_id", { ascending: true });

  const weekId = options.weekId ? String(options.weekId).trim() : "";
  if (weekId) query = query.eq("week_id", weekId);

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(
        "[user_activity_details] table not found; returning empty result.",
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[user_activity_details] query failed", {
      message: error.message,
    });
    throw new Error(error.message);
  }

  const rows = ((data ?? []) as Record<string, unknown>[]).map(normalizeRow);

  // modal 필터는 classification 으로 클라이언트단에서 적용 (DB 컬럼이 아니라 prefix rule).
  if (options.modal) {
    return {
      rows: rows.filter((row) => classifyActivityType(row.activity_type_id) === options.modal),
      available: true,
    };
  }

  return { rows, available: true };
}

export class UserActivityDetailsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "UserActivityDetailsError";
  }
}

// Validation policies — DB 제약 (rating CHECK) + 코드 base 가정.
const SUB_TITLE_MAX = 300;
const GROWTH_POINT_MAX = 2000;
const IMAGE_SLOT_MAX = 4;
const OUTPUT_LINK_MAX = 5;
const IMAGE_CAPTION_MAX = 200;

function normalizeNullableText(
  value: unknown,
  max: number,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = typeof value === "string" ? value : String(value);
  const trimmed = stringValue.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new UserActivityDetailsError(
      400,
      `${field} 는 최대 ${max} 자입니다.`,
    );
  }
  return trimmed;
}

function normalizeImageArray(
  urls: unknown,
  captions: unknown,
): { urls: string[]; captions: string[] } {
  if (!Array.isArray(urls)) return { urls: [], captions: [] };
  if (urls.length > IMAGE_SLOT_MAX) {
    throw new UserActivityDetailsError(
      400,
      `이미지는 최대 ${IMAGE_SLOT_MAX} 개까지 지정할 수 있습니다.`,
    );
  }
  const normUrls = urls.map((entry) => {
    if (typeof entry !== "string") return "";
    const trimmed = entry.trim();
    return trimmed;
  });
  const capArray = Array.isArray(captions) ? captions : [];
  const normCaptions = normUrls.map((_, index) => {
    const cap = capArray[index];
    if (typeof cap !== "string") return "";
    const trimmed = cap.trim();
    if (trimmed.length > IMAGE_CAPTION_MAX) {
      throw new UserActivityDetailsError(
        400,
        `이미지 캡션은 최대 ${IMAGE_CAPTION_MAX} 자입니다.`,
      );
    }
    return trimmed;
  });
  return { urls: normUrls, captions: normCaptions };
}

function normalizeOutputLinks(value: unknown): UserActivityOutputLink[] {
  if (!Array.isArray(value)) return [];
  if (value.length > OUTPUT_LINK_MAX) {
    throw new UserActivityDetailsError(
      400,
      `output 링크는 최대 ${OUTPUT_LINK_MAX} 개입니다.`,
    );
  }
  const rows: UserActivityOutputLink[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url) continue;
    const descRaw = typeof record.desc === "string" ? record.desc.trim() : "";
    rows.push({ url, desc: descRaw === "" ? null : descRaw });
  }
  return rows;
}

function normalizeRating(
  value: unknown,
  modal: UserActivityModalKey | "unknown",
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) {
    throw new UserActivityDetailsError(400, "rating 은 숫자여야 합니다.");
  }
  if (n < 0 || n > 10) {
    throw new UserActivityDetailsError(400, "rating 은 0~10 사이여야 합니다.");
  }
  if (modal !== "work_exp" && modal !== "unknown") {
    // info/ability/career 에서는 rating 을 NULL 로 강제.
    return null;
  }
  return n;
}

// 본 admin upsert 는 (user_id, week_id, activity_type_id) scope.
// id 가 입력으로 주어지면 해당 row 의 ownership 만 확인 후 같은 scope 으로 update.
export async function upsertUserActivityDetail(
  userId: string,
  input: UserActivityDetailUpsertInput,
): Promise<UserActivityDetailRow> {
  const trimmedUser = String(userId ?? "").trim();
  if (!trimmedUser) {
    throw new UserActivityDetailsError(400, "userId is required.");
  }
  const weekId = String(input.week_id ?? "").trim();
  if (!weekId) {
    throw new UserActivityDetailsError(400, "week_id is required.");
  }
  const activityTypeId = String(input.activity_type_id ?? "").trim();
  if (!activityTypeId) {
    throw new UserActivityDetailsError(400, "activity_type_id is required.");
  }

  const modal = classifyActivityType(activityTypeId);

  const payload = {
    sub_title: normalizeNullableText(input.sub_title, SUB_TITLE_MAX, "sub_title"),
    growth_point: normalizeNullableText(
      input.growth_point,
      GROWTH_POINT_MAX,
      "growth_point",
    ),
    output_links: normalizeOutputLinks(input.output_links),
    ...normalizeImageArray(input.image_urls, input.image_captions),
    growth_image_url: normalizeNullableText(
      input.growth_image_url,
      500,
      "growth_image_url",
    ),
    growth_image_caption: normalizeNullableText(
      input.growth_image_caption,
      IMAGE_CAPTION_MAX,
      "growth_image_caption",
    ),
    rating: normalizeRating(input.rating, modal),
  };

  const upsertRow = {
    user_id: trimmedUser,
    week_id: weekId,
    activity_type_id: activityTypeId,
    sub_title: payload.sub_title,
    growth_point: payload.growth_point,
    output_links: payload.output_links,
    image_urls: payload.urls,
    image_captions: payload.captions,
    growth_image_url: payload.growth_image_url,
    growth_image_caption: payload.growth_image_caption,
    rating: payload.rating,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin
    .from("user_activity_details")
    .upsert(upsertRow, { onConflict: "user_id,week_id,activity_type_id" })
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    if (error && /user_activity_details_rating_range/i.test(error.message)) {
      throw new UserActivityDetailsError(400, "rating 은 0~10 사이여야 합니다.");
    }
    console.error("[user_activity_details] upsert failed", {
      message: error?.message,
    });
    throw new UserActivityDetailsError(
      500,
      error?.message ?? "Failed to upsert user_activity_details.",
    );
  }

  return normalizeRow(data as Record<string, unknown>);
}

export async function deleteUserActivityDetail(
  userId: string,
  rowId: string,
): Promise<string> {
  const trimmedUser = String(userId ?? "").trim();
  const id = String(rowId ?? "").trim();
  if (!trimmedUser) {
    throw new UserActivityDetailsError(400, "userId is required.");
  }
  if (!id) {
    throw new UserActivityDetailsError(400, "user_activity_details id is required.");
  }

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("user_activity_details")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();

  if (lookupError) {
    if (isMissingRelationError(lookupError)) {
      throw new UserActivityDetailsError(404, "user_activity_details not found.");
    }
    throw new UserActivityDetailsError(500, lookupError.message);
  }
  if (!existing) {
    throw new UserActivityDetailsError(404, "user_activity_details not found.");
  }
  if ((existing as { user_id?: string }).user_id !== trimmedUser) {
    throw new UserActivityDetailsError(
      403,
      "user_activity_details does not belong to this crew.",
    );
  }

  const { error } = await supabaseAdmin
    .from("user_activity_details")
    .delete()
    .eq("id", id)
    .eq("user_id", trimmedUser);

  if (error) {
    throw new UserActivityDetailsError(500, error.message);
  }

  return id;
}
