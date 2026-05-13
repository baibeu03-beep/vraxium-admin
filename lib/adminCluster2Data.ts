import { supabaseAdmin } from "@/lib/supabaseAdmin";

// ─────────────────────────────────────────────────────────────────────
// Cluster2 admin — source of truth (실제 supabase schema 기준, 2026-05-12)
//
//   user_cluster2 (1:1, PK: user_id)
//     - sidebar_photo_url / main_photo_url / sub_photo_1_url ~ sub_photo_4_url
//     - video_url_1 ~ video_url_3
//     - growth_story / social_experience / career_direction / work_style / personal_story
//     - cluving_review_link   (readonly — admin editor 표시만)
//
//   user_introductions (1:1, PK: user_id)
//     - slogan_1 / slogan_2 / slogan_3                 (text)
//     - slogan_1_tag / slogan_2_tag / slogan_3_tag     (text)
//     - slogan_1_rating / slogan_2_rating / slogan_3_rating (integer, 0~10 권장)
//
//   user_educations (1:N, PK: id, key: user_id)
//     core (편집):  school_name, major_name_1, sort_order(integer), is_primary(boolean)
//     extra (편집, 모두 text):
//       education_level, status, major_category,
//       major_name_2, major_name_3,
//       admission_year, admission_month,
//       graduation_year, graduation_month,
//       grade_max_type, grade_value, note
//     readonly:     id(uuid), user_id(uuid), created_at, updated_at
//     (2026-05-13 PostgREST OpenAPI 기준 — admission_year/month, graduation_year/month,
//      grade_value 는 모두 DB 가 text 컬럼. 정수 캐스팅 금지.)
//
// 정책:
//   - routeParam = user_profiles.user_id (UUID) 만 사용.
//   - user_cluster2 / user_introductions row 가 없으면 GET 은 null-safe bundle,
//     PATCH 첫 저장 시 자동 upsert.
//   - user_educations 는 body 에 포함된 경우에만 user_id 전체 delete + insert.
//     ⇒ id 는 매번 새로 발급되므로 admin form 에서 readonly 표시만 한다.
//   - cluving_review_link 는 admin editor 에서 readonly 표시. PATCH 미수용.
//   - 존재하지 않는 컬럼 (sub_photo_5 등)은 절대 select / update 하지 않는다.
// ─────────────────────────────────────────────────────────────────────

export class Cluster2Error extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "Cluster2Error";
  }
}

type Row = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────
// Field whitelists (PATCH body 의 임의 컬럼 update 차단용)
// ─────────────────────────────────────────────────────────────────────
// 정책 (2026-05-12):
//   sidebar(profile) photo  → user_profiles.profile_photo_url
//   cluster2 photos (main + sub 4) → user_cluster2.{main_photo_url, sub_photo_*_url}
// user_cluster2.sidebar_photo_url 컬럼이 schema 에 존재하지만, admin/front
// 양쪽 모두 sidebar 사진은 user_profiles 를 canonical 로 사용한다.
export const CLUSTER2_PHOTO_FIELDS = [
  "main_photo_url",
  "sub_photo_1_url",
  "sub_photo_2_url",
  "sub_photo_3_url",
  "sub_photo_4_url",
] as const;

export const VIDEO_FIELDS = [
  "video_url_1",
  "video_url_2",
  "video_url_3",
] as const;

// 자기소개서 5문항 — front 와 동일하게 각 항목 1,000자 제한.
// admin editor / API 모두 이 상수를 기준으로 검증한다.
export const INTRODUCTION_MAX_LENGTH = 1000;

export const INTRODUCTION_FIELDS = [
  "growth_story",
  "social_experience",
  "career_direction",
  "work_style",
  "personal_story",
] as const;

// text 3 + tag(text) 3 + rating(integer) 3. PostgREST OpenAPI 로 schema 확인됨 (2026-05-13).
// slogan_*_rating 은 DB 가 integer 라 admin 측에서도 정수로 normalize 한다.
export const SLOGAN_FIELDS = [
  "slogan_1",
  "slogan_2",
  "slogan_3",
  "slogan_1_tag",
  "slogan_2_tag",
  "slogan_3_tag",
  "slogan_1_rating",
  "slogan_2_rating",
  "slogan_3_rating",
] as const;

// 편집 가능한 컬럼 화이트리스트 (id/user_id/created_at/updated_at 제외).
// DB 컬럼 타입은 sort_order=integer, is_primary=boolean, 나머지 12개=text.
export const EDUCATION_CORE_FIELDS = [
  "school_name",
  "major_name_1",
  "sort_order",
  "is_primary",
] as const;

export const EDUCATION_EXTRA_TEXT_FIELDS = [
  "education_level",
  "status",
  "major_category",
  "major_name_2",
  "major_name_3",
  "admission_year",
  "admission_month",
  "graduation_year",
  "graduation_month",
  "grade_max_type",
  "grade_value",
  "note",
] as const;

export const EDUCATION_INPUT_FIELDS = [
  ...EDUCATION_CORE_FIELDS,
  ...EDUCATION_EXTRA_TEXT_FIELDS,
] as const;

// GET 시 함께 가져오는 readonly meta 컬럼.
const EDUCATION_READONLY_META_FIELDS = [
  "id",
  "user_id",
  "created_at",
  "updated_at",
] as const;

const EDUCATION_SELECT = [
  ...EDUCATION_READONLY_META_FIELDS,
  ...EDUCATION_INPUT_FIELDS,
].join(",");

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────
export type Cluster2EducationDto = {
  // readonly meta
  id: string | number;
  user_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  // core (editable)
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number;
  is_primary: boolean;
  // extra text columns (editable)
  education_level: string | null;
  status: string | null;
  major_category: string | null;
  major_name_2: string | null;
  major_name_3: string | null;
  admission_year: string | null;
  admission_month: string | null;
  graduation_year: string | null;
  graduation_month: string | null;
  grade_max_type: string | null;
  grade_value: string | null;
  note: string | null;
};

export type Cluster2Bundle = {
  legacyUserId: string;
  userId: string | null;
  photos: {
    sidebarPhoto: string | null;
    mainPhoto: string | null;
    subPhotos: (string | null)[]; // 길이 4 — sub_photo_1_url ~ _4_url
  } | null;
  slogans:
    | Record<(typeof SLOGAN_FIELDS)[number], string | number | null>
    | null;
  videos: Record<(typeof VIDEO_FIELDS)[number], string | null> | null;
  introductions:
    | Record<(typeof INTRODUCTION_FIELDS)[number], string | null>
    | null;
  educations: Cluster2EducationDto[];
  reviewLink: {
    cluving_review_link: string | null;
    readonly: true;
    window: {
      resourceKey: typeof REVIEW_LINK_RESOURCE_KEY;
      status: "open" | "scheduled" | "expired" | "not_granted";
      openedAt: string | null;
      expiresAt: string | null;
    };
  };
};

export type EducationInput = Partial<{
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number;
  is_primary: boolean;
  education_level: string | null;
  status: string | null;
  major_category: string | null;
  major_name_2: string | null;
  major_name_3: string | null;
  admission_year: string | null;
  admission_month: string | null;
  graduation_year: string | null;
  graduation_month: string | null;
  grade_max_type: string | null;
  grade_value: string | null;
  note: string | null;
}>;

export type Cluster2PatchBody = {
  photos?: {
    sidebarPhoto?: string | null;
    mainPhoto?: string | null;
    subPhotos?: (string | null)[];
  };
  slogans?: Partial<Record<(typeof SLOGAN_FIELDS)[number], unknown>>;
  videos?: Partial<Record<(typeof VIDEO_FIELDS)[number], unknown>>;
  introductions?: Partial<
    Record<(typeof INTRODUCTION_FIELDS)[number], unknown>
  >;
  educations?: EducationInput[];
};

type Section = "photos" | "slogans" | "videos" | "introductions" | "educations";

// admin editor 의 Review Link 값 자체는 1차 범위에서 readonly 유지하지만,
// 사용자의 작성 가능 여부는 user_edit_windows 로 판정해서 안내 문구로 노출한다.
const REVIEW_LINK_RESOURCE_KEY = "cluster2.review_links" as const;

type ReviewLinkWindow = Cluster2Bundle["reviewLink"]["window"];

function computeReviewLinkWindow(
  row: {
    opened_at: string | null;
    expires_at: string | null;
  } | null,
  now: Date = new Date(),
): ReviewLinkWindow {
  if (!row) {
    return {
      resourceKey: REVIEW_LINK_RESOURCE_KEY,
      status: "not_granted",
      openedAt: null,
      expiresAt: null,
    };
  }
  const opened = row.opened_at ? new Date(row.opened_at) : null;
  const expires = row.expires_at ? new Date(row.expires_at) : null;
  const openedValid = opened && !Number.isNaN(opened.getTime());
  const expiresValid = expires && !Number.isNaN(expires.getTime());

  let status: ReviewLinkWindow["status"] = "not_granted";
  if (openedValid && expiresValid) {
    if (now.getTime() < opened.getTime()) status = "scheduled";
    else if (now.getTime() > expires.getTime()) status = "expired";
    else status = "open";
  }

  return {
    resourceKey: REVIEW_LINK_RESOURCE_KEY,
    status,
    openedAt: openedValid ? opened.toISOString() : row.opened_at,
    expiresAt: expiresValid ? expires.toISOString() : row.expires_at,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────
// blob:/data:/file: 같은 local-only URL 은 DB 에 보존되지 않으므로
// 서버 단에서 한 번 더 null 로 정규화한다 (client-side sanitize 의 백업망).
function sanitizeStorageUrl(value: unknown): string | null {
  if (typeof value !== "string") return value === null ? null : null;
  const v = value.trim();
  if (!v) return null;
  if (
    v.startsWith("blob:") ||
    v.startsWith("data:") ||
    v.startsWith("file:")
  ) {
    return null;
  }
  return v;
}

function isLocalPreviewUrl(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.startsWith("blob:") ||
      value.startsWith("data:") ||
      value.startsWith("file:"))
  );
}

function pickWritable(
  body: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

function readText(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === "string" ? v : v == null ? null : String(v);
}

function toEducationDto(row: Row): Cluster2EducationDto {
  const dto: Cluster2EducationDto = {
    id: (row.id as string | number) ?? "",
    user_id: readText(row, "user_id"),
    created_at: readText(row, "created_at"),
    updated_at: readText(row, "updated_at"),
    school_name: readText(row, "school_name"),
    major_name_1: readText(row, "major_name_1"),
    sort_order:
      typeof row.sort_order === "number"
        ? row.sort_order
        : Number(row.sort_order ?? 0),
    is_primary: Boolean(row.is_primary),
    education_level: readText(row, "education_level"),
    status: readText(row, "status"),
    major_category: readText(row, "major_category"),
    major_name_2: readText(row, "major_name_2"),
    major_name_3: readText(row, "major_name_3"),
    admission_year: readText(row, "admission_year"),
    admission_month: readText(row, "admission_month"),
    graduation_year: readText(row, "graduation_year"),
    graduation_month: readText(row, "graduation_month"),
    grade_max_type: readText(row, "grade_max_type"),
    grade_value: readText(row, "grade_value"),
    note: readText(row, "note"),
  };
  return dto;
}

function normString(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "-") return null;
  return trimmed;
}

function fromEducationInput(input: EducationInput, fallbackIndex: number) {
  const sortOrder =
    typeof input.sort_order === "number"
      ? input.sort_order
      : Number(input.sort_order ?? fallbackIndex + 1);

  const out: Record<string, unknown> = {
    school_name: normString(input.school_name),
    major_name_1: normString(input.major_name_1),
    sort_order: Number.isFinite(sortOrder) ? sortOrder : fallbackIndex + 1,
    is_primary: Boolean(input.is_primary),
  };
  for (const key of EDUCATION_EXTRA_TEXT_FIELDS) {
    out[key] = normString(
      (input as Record<string, string | null | undefined>)[key],
    );
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// routeParam (= user_profiles.user_id, UUID) 해석
//   missing vs query error 를 구분해 로그.
//   매칭 실패 시 null (readonly fallback).
// ─────────────────────────────────────────────────────────────────────
async function resolveUserId(routeParam: string): Promise<string | null> {
  const id = String(routeParam).trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", id)
    .maybeSingle();

  if (error) {
    console.error("[cluster2] query failed (user_profiles lookup)", {
      routeParam: id,
      message: error.message,
    });
    throw new Cluster2Error(500, error.message);
  }

  const userId = (data as { user_id?: string } | null)?.user_id ?? null;
  if (!userId) {
    console.warn("[cluster2] user_profiles missing", { routeParam: id });
  }
  return userId;
}

// ─────────────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────────────
export async function getCluster2ForCrew(
  legacyUserId: string,
): Promise<Cluster2Bundle | null> {
  const userId = await resolveUserId(legacyUserId);

  if (!userId) {
    return {
      legacyUserId,
      userId: null,
      photos: null,
      slogans: null,
      videos: null,
      introductions: null,
      educations: [],
      reviewLink: {
        cluving_review_link: null,
        readonly: true,
        window: computeReviewLinkWindow(null),
      },
    };
  }

  const [profileRes, clusterRes, introRes, eduRes, windowRes] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("profile_photo_url")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_cluster2")
      .select(
        [
          ...CLUSTER2_PHOTO_FIELDS,
          ...VIDEO_FIELDS,
          ...INTRODUCTION_FIELDS,
          "cluving_review_link",
        ].join(","),
      )
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_introductions")
      .select(SLOGAN_FIELDS.join(","))
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_educations")
      .select(EDUCATION_SELECT)
      .eq("user_id", userId)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("user_edit_windows")
      .select("opened_at,expires_at")
      .eq("user_id", userId)
      .eq("resource_key", REVIEW_LINK_RESOURCE_KEY)
      .maybeSingle(),
  ]);

  for (const res of [profileRes, clusterRes, introRes, eduRes, windowRes]) {
    if (res.error) {
      console.error("[cluster2] query failed (GET bundle)", {
        userId,
        message: res.error.message,
      });
      throw new Cluster2Error(500, res.error.message);
    }
  }

  const profile = (profileRes.data ?? null) as {
    profile_photo_url: string | null;
  } | null;
  const cluster = (clusterRes.data ?? null) as Row | null;
  const intro = (introRes.data ?? null) as Row | null;
  const eduRows = ((eduRes.data ?? []) as unknown) as Row[];

  const photos = {
    sidebarPhoto: profile?.profile_photo_url ?? null,
    mainPhoto: (cluster?.main_photo_url as string | null) ?? null,
    subPhotos: [
      (cluster?.sub_photo_1_url as string | null) ?? null,
      (cluster?.sub_photo_2_url as string | null) ?? null,
      (cluster?.sub_photo_3_url as string | null) ?? null,
      (cluster?.sub_photo_4_url as string | null) ?? null,
    ],
  };

  const videos = {
    video_url_1: (cluster?.video_url_1 as string | null) ?? null,
    video_url_2: (cluster?.video_url_2 as string | null) ?? null,
    video_url_3: (cluster?.video_url_3 as string | null) ?? null,
  };

  const introductions = {
    growth_story: (cluster?.growth_story as string | null) ?? null,
    social_experience: (cluster?.social_experience as string | null) ?? null,
    career_direction: (cluster?.career_direction as string | null) ?? null,
    work_style: (cluster?.work_style as string | null) ?? null,
    personal_story: (cluster?.personal_story as string | null) ?? null,
  };

  const slogans = {
    slogan_1: (intro?.slogan_1 as string | null) ?? null,
    slogan_2: (intro?.slogan_2 as string | null) ?? null,
    slogan_3: (intro?.slogan_3 as string | null) ?? null,
    slogan_1_tag: (intro?.slogan_1_tag as string | null) ?? null,
    slogan_2_tag: (intro?.slogan_2_tag as string | null) ?? null,
    slogan_3_tag: (intro?.slogan_3_tag as string | null) ?? null,
    slogan_1_rating: (intro?.slogan_1_rating as number | null) ?? null,
    slogan_2_rating: (intro?.slogan_2_rating as number | null) ?? null,
    slogan_3_rating: (intro?.slogan_3_rating as number | null) ?? null,
  };

  const windowRow = (windowRes.data ?? null) as {
    opened_at: string | null;
    expires_at: string | null;
  } | null;

  return {
    legacyUserId,
    userId,
    photos,
    slogans,
    videos,
    introductions,
    educations: eduRows.map(toEducationDto),
    reviewLink: {
      cluving_review_link:
        (cluster?.cluving_review_link as string | null) ?? null,
      readonly: true,
      window: computeReviewLinkWindow(windowRow),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// PATCH
// ─────────────────────────────────────────────────────────────────────
type ApplySummary = Partial<Record<Section, Record<string, unknown>>>;

async function upsertCluster2(
  userId: string,
  patch: Record<string, unknown>,
) {
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabaseAdmin
    .from("user_cluster2")
    .upsert(
      {
        user_id: userId,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (error) {
    console.error("[cluster2] query failed (upsert user_cluster2)", {
      userId,
      message: error.message,
    });
    throw new Cluster2Error(500, error.message);
  }
}

async function upsertIntroductions(
  userId: string,
  patch: Record<string, unknown>,
) {
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabaseAdmin
    .from("user_introductions")
    .upsert(
      {
        user_id: userId,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (error) {
    console.error("[cluster2] query failed (upsert user_introductions)", {
      userId,
      message: error.message,
    });
    throw new Cluster2Error(500, error.message);
  }
}

export async function patchCluster2ForCrew(
  legacyUserId: string,
  body: Cluster2PatchBody,
): Promise<{
  bundle: Cluster2Bundle | null;
  warnings: string[];
  applied: ApplySummary;
}> {
  if (!body || typeof body !== "object") {
    throw new Cluster2Error(400, "Invalid body");
  }

  const sectionKeys: Section[] = [
    "photos",
    "slogans",
    "videos",
    "introductions",
    "educations",
  ];
  const hasAnySection = sectionKeys.some(
    (key) => (body as Record<string, unknown>)[key] !== undefined,
  );
  if (!hasAnySection) {
    throw new Cluster2Error(400, "No updatable sections in body");
  }

  const userId = await resolveUserId(legacyUserId);
  if (!userId) {
    throw new Cluster2Error(
      409,
      "user_profiles 매칭 행이 없어 cluster2 데이터를 수정할 수 없습니다.",
    );
  }

  const warnings: string[] = [];
  const applied: ApplySummary = {};

  // 1) Photos
  //    sidebar → user_profiles.profile_photo_url
  //    main / sub 1~4 → user_cluster2
  //    blob:/data:/file: URL 은 null 로 정규화 (DB 가 local preview 보관 금지).
  if (body.photos !== undefined) {
    const cluster2Patch: Record<string, unknown> = {};
    const profilePatch: Record<string, unknown> = {};
    let strippedCount = 0;

    if ("sidebarPhoto" in body.photos) {
      if (isLocalPreviewUrl(body.photos.sidebarPhoto)) strippedCount += 1;
      profilePatch.profile_photo_url = sanitizeStorageUrl(
        body.photos.sidebarPhoto,
      );
    }
    if ("mainPhoto" in body.photos) {
      if (isLocalPreviewUrl(body.photos.mainPhoto)) strippedCount += 1;
      cluster2Patch.main_photo_url = sanitizeStorageUrl(body.photos.mainPhoto);
    }
    if (Array.isArray(body.photos.subPhotos)) {
      const subs = body.photos.subPhotos;
      for (let i = 0; i < 4; i++) {
        if (isLocalPreviewUrl(subs[i])) strippedCount += 1;
      }
      cluster2Patch.sub_photo_1_url = sanitizeStorageUrl(subs[0]);
      cluster2Patch.sub_photo_2_url = sanitizeStorageUrl(subs[1]);
      cluster2Patch.sub_photo_3_url = sanitizeStorageUrl(subs[2]);
      cluster2Patch.sub_photo_4_url = sanitizeStorageUrl(subs[3]);
    }

    if (strippedCount > 0) {
      warnings.push(
        `local preview URL (blob:/data:/file:) ${strippedCount}개를 storage URL 이 아니어서 null 로 저장했습니다. front 의 업로드가 실패한 슬롯입니다.`,
      );
    }

    if (Object.keys(profilePatch).length > 0) {
      const { error } = await supabaseAdmin
        .from("user_profiles")
        .update({
          ...profilePatch,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", userId);
      if (error) {
        console.error("[cluster2] query failed (update user_profiles)", {
          userId,
          message: error.message,
        });
        throw new Cluster2Error(500, error.message);
      }
    }
    if (Object.keys(cluster2Patch).length > 0) {
      await upsertCluster2(userId, cluster2Patch);
    }
    applied.photos = { ...profilePatch, ...cluster2Patch };
  }

  // 2) Videos → user_cluster2
  if (body.videos !== undefined) {
    const patch = pickWritable(body.videos, VIDEO_FIELDS);
    await upsertCluster2(userId, patch);
    applied.videos = patch;
  }

  // 3) Introductions (5 문항) → user_cluster2
  //    각 항목 INTRODUCTION_MAX_LENGTH(1,000자) 이내만 허용.
  if (body.introductions !== undefined) {
    const patch = pickWritable(body.introductions, INTRODUCTION_FIELDS);
    const overLength = Object.entries(patch).filter(
      ([, v]) => typeof v === "string" && v.length > INTRODUCTION_MAX_LENGTH,
    );
    if (overLength.length > 0) {
      throw new Cluster2Error(
        400,
        `Introduction fields must be ${INTRODUCTION_MAX_LENGTH} characters or less (over: ${overLength
          .map(([k]) => k)
          .join(", ")})`,
      );
    }
    await upsertCluster2(userId, patch);
    applied.introductions = patch;
  }

  // 4) Slogans → user_introductions
  if (body.slogans !== undefined) {
    const patch = pickWritable(body.slogans, SLOGAN_FIELDS);
    await upsertIntroductions(userId, patch);
    applied.slogans = patch;
  }

  // 5) Educations → user_educations (body 포함 시 전체 갈아엎기)
  if (body.educations !== undefined) {
    if (!Array.isArray(body.educations)) {
      throw new Cluster2Error(400, "educations must be an array");
    }

    const primaryRows = body.educations.filter((e) => Boolean(e.is_primary));
    const sortZeroRows = body.educations.filter(
      (e) => Number(e.sort_order) === 0,
    );
    if (primaryRows.length > 1) {
      warnings.push(
        `is_primary=true row 가 ${primaryRows.length}개입니다. front Cluster2 표시가 비결정적일 수 있습니다.`,
      );
    }
    if (sortZeroRows.length > 1) {
      warnings.push(
        `sort_order=0 row 가 ${sortZeroRows.length}개입니다. 대표 학력 정렬이 불안정할 수 있습니다.`,
      );
    }
    // is_primary 와 sort_order=0 이 같은 row 를 가리키지 않으면 경고.
    const mismatchCount = body.educations.filter(
      (e) => Boolean(e.is_primary) !== (Number(e.sort_order) === 0),
    ).length;
    if (mismatchCount > 0) {
      warnings.push(
        `is_primary 와 sort_order=0 이 ${mismatchCount}개 row 에서 불일치합니다. 대표 학력 toggle 로 정리하는 것을 권장합니다.`,
      );
    }

    const records = body.educations.map((edu, index) => ({
      user_id: userId,
      ...fromEducationInput(edu, index),
    }));

    const { error: delErr } = await supabaseAdmin
      .from("user_educations")
      .delete()
      .eq("user_id", userId);
    if (delErr) {
      console.error("[cluster2] query failed (delete user_educations)", {
        userId,
        message: delErr.message,
      });
      throw new Cluster2Error(500, delErr.message);
    }

    if (records.length > 0) {
      const { error: insErr } = await supabaseAdmin
        .from("user_educations")
        .insert(records);
      if (insErr) {
        console.error("[cluster2] query failed (insert user_educations)", {
          userId,
          message: insErr.message,
        });
        throw new Cluster2Error(500, insErr.message);
      }
    }
    applied.educations = { count: records.length };
  }

  const bundle = await getCluster2ForCrew(legacyUserId);
  return { bundle, warnings, applied };
}
