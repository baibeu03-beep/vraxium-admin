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
//     - slogan_1, slogan_2, slogan_3
//     (slogan_*_tag / _rating 같은 컬럼은 schema 에 없음 — 사용 금지)
//
//   user_educations (1:N, PK: id, key: user_id)
//     - school_name, major_name_1, sort_order, is_primary
//
// 정책:
//   - routeParam = user_profiles.user_id (UUID) 만 사용.
//   - user_cluster2 / user_introductions row 가 없으면 GET 은 null-safe bundle,
//     PATCH 첫 저장 시 자동 upsert.
//   - user_educations 는 body 에 포함된 경우에만 user_id 전체 delete + insert.
//   - cluving_review_link 는 admin editor 에서 readonly 표시. PATCH 미수용.
//   - 존재하지 않는 컬럼 (sub_photo_5, slogan_*_tag, education status/category 등)은
//     절대 select / update 하지 않는다.
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

export const INTRODUCTION_FIELDS = [
  "growth_story",
  "social_experience",
  "career_direction",
  "work_style",
  "personal_story",
] as const;

export const SLOGAN_FIELDS = ["slogan_1", "slogan_2", "slogan_3"] as const;

export const EDUCATION_INPUT_FIELDS = [
  "school_name",
  "major_name_1",
  "sort_order",
  "is_primary",
] as const;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────
export type Cluster2EducationDto = {
  id: string | number;
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number;
  is_primary: boolean;
};

export type Cluster2Bundle = {
  legacyUserId: string;
  userId: string | null;
  photos: {
    sidebarPhoto: string | null;
    mainPhoto: string | null;
    subPhotos: (string | null)[]; // 길이 4 — sub_photo_1_url ~ _4_url
  } | null;
  slogans: Record<(typeof SLOGAN_FIELDS)[number], string | null> | null;
  videos: Record<(typeof VIDEO_FIELDS)[number], string | null> | null;
  introductions:
    | Record<(typeof INTRODUCTION_FIELDS)[number], string | null>
    | null;
  educations: Cluster2EducationDto[];
  reviewLink: {
    cluving_review_link: string | null;
    locked: true;
    lockReason: string;
  };
};

export type EducationInput = Partial<{
  school_name: string | null;
  major_name_1: string | null;
  sort_order: number;
  is_primary: boolean;
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

const REVIEW_LINK_LOCK_REASON =
  "policy: review-link 은 관리자 권한/윈도우 정책 도입 전까지 readonly 입니다.";

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

function toEducationDto(row: Row): Cluster2EducationDto {
  return {
    id: (row.id as string | number) ?? "",
    school_name: (row.school_name as string | null) ?? null,
    major_name_1: (row.major_name_1 as string | null) ?? null,
    sort_order:
      typeof row.sort_order === "number"
        ? row.sort_order
        : Number(row.sort_order ?? 0),
    is_primary: Boolean(row.is_primary),
  };
}

function fromEducationInput(input: EducationInput, fallbackIndex: number) {
  const sortOrder =
    typeof input.sort_order === "number"
      ? input.sort_order
      : Number(input.sort_order ?? fallbackIndex + 1);

  const normString = (value: string | null | undefined) => {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (!trimmed || trimmed === "-") return null;
    return trimmed;
  };

  return {
    school_name: normString(input.school_name),
    major_name_1: normString(input.major_name_1),
    sort_order: Number.isFinite(sortOrder) ? sortOrder : fallbackIndex + 1,
    is_primary: Boolean(input.is_primary),
  };
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
        locked: true,
        lockReason: REVIEW_LINK_LOCK_REASON,
      },
    };
  }

  const [profileRes, clusterRes, introRes, eduRes] = await Promise.all([
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
      .select("id, school_name, major_name_1, sort_order, is_primary")
      .eq("user_id", userId)
      .order("sort_order", { ascending: true }),
  ]);

  for (const res of [profileRes, clusterRes, introRes, eduRes]) {
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
  const eduRows = (eduRes.data ?? []) as Row[];

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
  };

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
      locked: true,
      lockReason: REVIEW_LINK_LOCK_REASON,
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
  if (body.introductions !== undefined) {
    const patch = pickWritable(body.introductions, INTRODUCTION_FIELDS);
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

    const primaryCount = body.educations.filter(
      (e) => Boolean(e.is_primary) || Number(e.sort_order) === 0,
    ).length;
    if (primaryCount > 1) {
      warnings.push(
        `is_primary=true (또는 sort_order=0) row 가 ${primaryCount}개입니다. front Cluster2 표시가 비결정적일 수 있습니다.`,
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
