// Server-only data layer for user_activity_details (Cluster4-card 활동 모달).
// Admin Cluster4Editor 에서 사용. user-facing API 는 Career-Resume repo 별도.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  classifyActivityType,
  type ActivityTypeClusterMap,
  type UserActivityDetailRow,
  type UserActivityDetailUpsertInput,
  type UserActivityDetailsListOptions,
  type UserActivityDetailsListResult,
  type UserActivityModalKey,
  type UserActivityOutputLink,
} from "@/lib/userActivityDetailsTypes";

const SELECT_COLUMNS =
  "id,user_id,week_id,activity_type_id,sub_title,output_links,growth_point,image_urls,image_captions,rating,created_at,updated_at";

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
    rating: toNullableNumber(raw.rating),
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
  };
}

// activity_types(id, cluster_id) lookup map. cluster_id 기반 분류의 canonical
// source. Career-Resume 프론트도 이 값을 기준으로 modal 을 분기하므로 어드민도
// 동일 source 를 써야 mismatch 없이 분류된다.
export async function fetchActivityTypesClusterMap(): Promise<{
  map: ActivityTypeClusterMap;
  available: boolean;
}> {
  const { data, error } = await supabaseAdmin
    .from("activity_types")
    .select("id, cluster_id");

  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(
        "[activity_types] table not found; cluster-id classification disabled (prefix fallback only).",
        { message: error.message },
      );
      return { map: {}, available: false };
    }
    console.error("[activity_types] query failed", { message: error.message });
    throw new Error(error.message);
  }

  const map: ActivityTypeClusterMap = {};
  for (const row of (data ?? []) as Array<{
    id?: string | null;
    cluster_id?: string | null;
  }>) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const clusterId =
      typeof row.cluster_id === "string" ? row.cluster_id.trim() : "";
    if (id && clusterId) map[id] = clusterId;
  }
  return { map, available: true };
}

export async function listUserActivityDetails(
  options: UserActivityDetailsListOptions,
  clusterMap?: ActivityTypeClusterMap | null,
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

  // modal 필터는 classification 으로 적용. cluster map 이 있으면 cluster_id 기반,
  // 없으면 prefix fallback (legacy 호환).
  if (options.modal) {
    let effectiveMap = clusterMap ?? null;
    if (effectiveMap === null) {
      const fetched = await fetchActivityTypesClusterMap();
      effectiveMap = fetched.available ? fetched.map : null;
    }
    return {
      rows: rows.filter(
        (row) =>
          classifyActivityType(row.activity_type_id, effectiveMap) ===
          options.modal,
      ),
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

// Partial upsert by (user_id, week_id, activity_type_id) scope.
//
// 동작 (2026-05-22 partial-update 도입):
//   1) (user_id, week_id, activity_type_id) 로 기존 row 를 select.
//   2) 존재 → input 에 키가 포함된 컬럼만 UPDATE 한다. 미포함 컬럼은 보존.
//      이미지 페어(image_urls / image_captions) 는 한쪽만 input 에 있어도
//      나머지를 기존 DB 값으로 채워 정렬 후 함께 update.
//   3) 부재 → INSERT. 누락된 optional 필드는 default(null/[]/null) 로 채움.
//
// clusterMap 이 전달되면 cluster_id 기반 modal 분류로 rating 정책을 결정 (없으면
// prefix fallback). bundle 단위 호출자는 한번 fetch 한 map 을 재사용한다.
//
// Rationale: 이전 full-replace upsert 는 admin 폼이 빈 슬롯을 가진 상태에서
// 사용자가 한 필드만 수정해도 다른 컬럼을 빈 값으로 덮어쓰는 버그가 있었다
// (예: 프론트가 growth_point + 이미지 저장 → 어드민이 sub_title 만 수정 →
// 이미지/growth_point 가 [] / null 로 덮어써짐). partial-update 로 해결.
export async function upsertUserActivityDetail(
  userId: string,
  input: UserActivityDetailUpsertInput,
  clusterMap?: ActivityTypeClusterMap | null,
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

  const modal = classifyActivityType(activityTypeId, clusterMap ?? null);

  // (1) 기존 row lookup. 부재면 null.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("user_activity_details")
    .select(SELECT_COLUMNS)
    .eq("user_id", trimmedUser)
    .eq("week_id", weekId)
    .eq("activity_type_id", activityTypeId)
    .maybeSingle();

  if (existingError) {
    console.error("[user_activity_details] lookup failed", {
      message: existingError.message,
    });
    throw new UserActivityDetailsError(500, existingError.message);
  }

  const existingRow = existing
    ? normalizeRow(existing as Record<string, unknown>)
    : null;

  // 어느 키가 explicit 으로 제공됐는지 추적 (undefined ≠ null).
  const has = <K extends keyof UserActivityDetailUpsertInput>(key: K): boolean =>
    Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

  // 이미지 페어 처리: 한쪽만 있어도 나머지를 기존 값으로 채워 정렬.
  let normalizedImages:
    | { urls: string[]; captions: string[] }
    | null = null;
  if (has("image_urls") || has("image_captions")) {
    const urlsInput = has("image_urls")
      ? input.image_urls
      : existingRow?.image_urls ?? [];
    const captionsInput = has("image_captions")
      ? input.image_captions
      : existingRow?.image_captions ?? [];
    normalizedImages = normalizeImageArray(urlsInput, captionsInput);
  }

  // 각 필드별 patch 값을 키 존재 시에만 산출.
  const patch: Record<string, unknown> = {};
  if (has("sub_title")) {
    patch.sub_title = normalizeNullableText(
      input.sub_title,
      SUB_TITLE_MAX,
      "sub_title",
    );
  }
  if (has("growth_point")) {
    patch.growth_point = normalizeNullableText(
      input.growth_point,
      GROWTH_POINT_MAX,
      "growth_point",
    );
  }
  if (has("output_links")) {
    patch.output_links = normalizeOutputLinks(input.output_links);
  }
  if (normalizedImages) {
    patch.image_urls = normalizedImages.urls;
    patch.image_captions = normalizedImages.captions;
  }
  if (has("rating")) {
    patch.rating = normalizeRating(input.rating, modal);
  }

  // (2) UPDATE 분기: 기존 row 가 있고 patch 가 비어 있지 않으면 update.
  if (existingRow) {
    if (Object.keys(patch).length === 0) {
      // no-op: 편집된 필드가 없음. 기존 row 그대로 반환.
      return existingRow;
    }
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("user_activity_details")
      .update(patch)
      .eq("id", existingRow.id)
      .eq("user_id", trimmedUser)
      .select(SELECT_COLUMNS)
      .single();

    if (error || !data) {
      if (error && /user_activity_details_rating_range/i.test(error.message)) {
        throw new UserActivityDetailsError(400, "rating 은 0~10 사이여야 합니다.");
      }
      console.error("[user_activity_details] partial update failed", {
        message: error?.message,
      });
      throw new UserActivityDetailsError(
        500,
        error?.message ?? "Failed to update user_activity_details.",
      );
    }
    return normalizeRow(data as Record<string, unknown>);
  }

  // (3) INSERT 분기: 기존 row 부재. 누락된 필드에 default 적용.
  const insertRow = {
    user_id: trimmedUser,
    week_id: weekId,
    activity_type_id: activityTypeId,
    sub_title: has("sub_title") ? (patch.sub_title as string | null) : null,
    growth_point: has("growth_point")
      ? (patch.growth_point as string | null)
      : null,
    output_links: has("output_links")
      ? (patch.output_links as UserActivityOutputLink[])
      : [],
    image_urls: normalizedImages ? normalizedImages.urls : [],
    image_captions: normalizedImages ? normalizedImages.captions : [],
    rating: has("rating") ? (patch.rating as number | null) : null,
  };

  const { data, error } = await supabaseAdmin
    .from("user_activity_details")
    .insert(insertRow)
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    if (error && /user_activity_details_rating_range/i.test(error.message)) {
      throw new UserActivityDetailsError(400, "rating 은 0~10 사이여야 합니다.");
    }
    console.error("[user_activity_details] insert failed", {
      message: error?.message,
    });
    throw new UserActivityDetailsError(
      500,
      error?.message ?? "Failed to insert user_activity_details.",
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
