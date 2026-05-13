import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import type { OrganizationSlug } from "@/lib/organizations";

// ─────────────────────────────────────────────────────────────────────
// Writable field whitelists
// 임의 컬럼 update 방지용. 화면에서 수정 가능한 컬럼만 명시한다.
// ─────────────────────────────────────────────────────────────────────
// 실제 user_profiles 스키마 기준 (2026-05-08 확인).
// contact_available: text 컬럼. user-app resume-card 모달에서 "연락 가능 시간대/코멘트"를
//   저장 (plain text 또는 JSON 문자열). admin editor에서도 동일 컬럼을 직접 편집한다.
// 제거됨: eng_name, phone, email, bio (DB 컬럼 미존재 → 500 유발)
// 제외(시스템): user_id, created_at, updated_at, growth_status, organization_slug,
//               school_name, department_name (학력은 user_educations에서 관리)
// dual-write 정리 (2026-05-13): profile_photo_url 제거 — Cluster 2 → Photos 가
//   canonical writer. Resume Card 는 표시만.
export const PROFILE_FIELDS = [
  "display_name",
  "gender",
  "birth_date",
  "address",
  "contact_phone",
  "contact_email",
  "contact_available",
  "vision",
  "status",
] as const;

// dual-write 정리 (2026-05-13): EDUCATION_FIELDS / body.education PATCH 블록 제거.
// user_educations 의 canonical writer 는 Cluster 2 → Educations (전체 row delete+insert).
// Resume Card GET 응답의 `education` 필드는 pickPrimaryEducation 결과로 계속 채움 (표시 전용).

export const MEMBERSHIP_FIELDS = [
  "team_name",
  "part_name",
  "membership_level",
  "membership_state",
  "is_current",
] as const;

// dual-write 정리 (2026-05-13): slogan_1 제거 — Cluster 2 → Slogans 가 canonical writer.
// 빈 whitelist 로 둬서 body.introduction 이 들어와도 서버가 silently drop 한다.
export const INTRODUCTION_FIELDS = [] as const;

export const USER_RESUME_CARD_SETTINGS_FIELDS = [
  "hexagon_link_1",
  "hexagon_link_2",
  "hexagon_link_3",
  "help_tooltip_text",
  "medal_week_override",
] as const;

export const ORG_RESUME_CARD_SETTINGS_FIELDS = [
  "medal_theme",
  "notice_top_text",
  "notice_top_stamp_image_url",
] as const;

export const SITE_RESUME_CARD_SETTINGS_FIELDS = [
  "notice_bottom_text",
  "notice_bottom_stamp_image_url",
  "help_tooltip_default",
] as const;

const SECTION_KEYS = [
  "profile",
  "education",
  "membership",
  "introduction",
  "resumeCardSettings",
] as const;

type Section = (typeof SECTION_KEYS)[number];

type FieldList = readonly string[];

function pickWritable(body: unknown, fields: FieldList): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in source) out[key] = source[key];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Custom error
// ─────────────────────────────────────────────────────────────────────
export class ResumeCardError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ResumeCardError";
  }
}

// ─────────────────────────────────────────────────────────────────────
// Education primary row picker
//   1) is_primary = true 우선 (복수면 sort_order 작은 쪽)
//   2) sort_order ASC
//   3) updated_at DESC (recency tiebreaker)
// user-app /api/profile, /api/educations 의 대표 학력 선택 기준과
// 반드시 동일해야 한다. lib/adminCrewData.ts:pickBestEducation 과도 일치.
// ─────────────────────────────────────────────────────────────────────
type EducationCandidate = {
  id: string | number;
  is_primary?: boolean | null;
  sort_order?: number | null;
  updated_at?: string | null;
};

function pickPrimaryEducation<T extends EducationCandidate>(
  rows: T[],
): T | null {
  if (!rows || rows.length === 0) return null;
  return (
    [...rows].sort((a, b) => {
      const primaryDelta =
        Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
      if (primaryDelta !== 0) return primaryDelta;
      const sortDelta =
        (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
        (b.sort_order ?? Number.MAX_SAFE_INTEGER);
      if (sortDelta !== 0) return sortDelta;
      return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
    })[0] ?? null
  );
}

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;

export type ResumeCardBundle = {
  legacyUserId: string;
  userId: string | null;
  profile: Row | null;
  education: Row | null;
  membership: Row | null;
  introduction: Row | null;
  resumeCardSettings: Row | null;
  computed: {
    approvedWeeks: number | null;
    cumulativeWeeks: number | null;
    totalStars: number | null;
    totalShields: number | null;
    totalLightnings: number | null;
  };
};

export type ResumeCardPatchBody = {
  profile?: unknown;
  education?: unknown;
  membership?: unknown;
  introduction?: unknown;
  resumeCardSettings?: unknown;
};

// ─────────────────────────────────────────────────────────────────────
// Per-crew GET
// ─────────────────────────────────────────────────────────────────────
export async function getResumeCardForCrew(
  legacyUserId: string,
): Promise<ResumeCardBundle | null> {
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return null;

  const userId = crew.userId;

  if (!userId) {
    return {
      legacyUserId: crew.legacyUserId,
      userId: null,
      profile: null,
      education: null,
      membership: null,
      introduction: null,
      resumeCardSettings: null,
      computed: {
        approvedWeeks: crew.approvedWeeks,
        cumulativeWeeks: crew.cumulativeWeeks,
        totalStars: null,
        totalShields: null,
        totalLightnings: null,
      },
    };
  }

  const [
    profileRes,
    educationRes,
    membershipRes,
    introductionRes,
    settingsRes,
    growthRes,
    pointsRes,
  ] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("*")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("user_educations")
      .select("*")
      .eq("user_id", userId),
    supabaseAdmin
      .from("user_memberships")
      .select("*")
      .eq("user_id", userId)
      .eq("is_current", true)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("user_introductions")
      .select("*")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("user_resume_card_settings")
      .select("*")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("user_growth_stats")
      .select("approved_weeks,cumulative_weeks")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("user_cumulative_points")
      .select("total_stars,total_shields,total_lightnings")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
  ]);

  const errors = [
    profileRes.error,
    educationRes.error,
    membershipRes.error,
    introductionRes.error,
    settingsRes.error,
    growthRes.error,
    pointsRes.error,
  ].filter((e): e is NonNullable<typeof e> => Boolean(e));

  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(" | "));
  }

  const growth = (growthRes.data ?? null) as
    | { approved_weeks: number | null; cumulative_weeks: number | null }
    | null;
  const points = (pointsRes.data ?? null) as
    | {
        total_stars: number | null;
        total_shields: number | null;
        total_lightnings: number | null;
      }
    | null;

  const educationRows = (educationRes.data ?? []) as Array<
    Row & EducationCandidate
  >;
  const primaryEducation = pickPrimaryEducation(educationRows);

  return {
    legacyUserId: crew.legacyUserId,
    userId,
    profile: (profileRes.data ?? null) as Row | null,
    education: (primaryEducation ?? null) as Row | null,
    membership: (membershipRes.data ?? null) as Row | null,
    introduction: (introductionRes.data ?? null) as Row | null,
    resumeCardSettings: (settingsRes.data ?? null) as Row | null,
    computed: {
      approvedWeeks: growth?.approved_weeks ?? crew.approvedWeeks ?? null,
      cumulativeWeeks: growth?.cumulative_weeks ?? crew.cumulativeWeeks ?? null,
      totalStars: points?.total_stars ?? null,
      totalShields: points?.total_shields ?? null,
      totalLightnings: points?.total_lightnings ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-crew PATCH
// ─────────────────────────────────────────────────────────────────────
export async function patchResumeCardForCrew(
  legacyUserId: string,
  body: ResumeCardPatchBody,
): Promise<{
  bundle: ResumeCardBundle | null;
  warnings: string[];
  applied: Partial<Record<Section, Record<string, unknown>>>;
}> {
  if (!body || typeof body !== "object") {
    throw new ResumeCardError(400, "Invalid body");
  }

  const hasAnySection = SECTION_KEYS.some(
    (key) => (body as Record<string, unknown>)[key] !== undefined,
  );
  if (!hasAnySection) {
    throw new ResumeCardError(400, "No updatable sections in body");
  }

  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) throw new ResumeCardError(404, "Crew not found");

  const userId = crew.userId;
  if (!userId) {
    throw new ResumeCardError(
      409,
      "Crew has no matching user_profiles row. Resume-card 편집은 user 매칭 후에만 가능합니다.",
    );
  }

  const warnings: string[] = [];
  const applied: Partial<Record<Section, Record<string, unknown>>> = {};

  // 1. user_profiles (1:1) — update only (row should already exist)
  if (body.profile !== undefined) {
    const patch = pickWritable(body.profile, PROFILE_FIELDS);
    if (Object.keys(patch).length > 0) {
      applied.profile = patch;
      const { error } = await supabaseAdmin
        .from("user_profiles")
        .update(patch)
        .eq("user_id", userId);
      if (error) throw error;
    }
  }

  // 2. user_educations — dual-write 정리 (2026-05-13) 로 PATCH 처리 제거됨.
  //    canonical writer = Cluster 2 → Educations (전체 row delete+insert).
  //    Resume Card 가 body.education 을 보내더라도 여기서 silently drop 한다.
  //    GET 의 대표학력 표시(`pickPrimaryEducation`)는 유지.

  // 3. user_memberships (is_current=true) — find-or-create
  // ResumeCardEditor.buildPatchBody 가 form 전체를 항상 PATCH 하므로, 다른 섹션만
  // 수정해도 membership payload 가 같이 실린다. 정체성 컬럼(team_name 등)이 모두
  // 비어 있으면 사용자가 membership 을 의도적으로 편집한 게 아니므로 skip — 빈 row
  // 자동 생성 / 같은 값으로 덮어쓰기 / "row 새로 생성했습니다" 경고를 모두 방지한다.
  // is_current 만 있는 경우는 checkbox 기본값(false) 일 수 있어 meaningful 로 치지 않는다.
  if (body.membership !== undefined) {
    const patch = pickWritable(body.membership, MEMBERSHIP_FIELDS);
    const hasMeaningfulMembership =
      !!patch.team_name ||
      !!patch.part_name ||
      !!patch.membership_level ||
      !!patch.membership_state;

    if (Object.keys(patch).length > 0 && hasMeaningfulMembership) {
      applied.membership = patch;
      const { data: existingRows, error: selErr } = await supabaseAdmin
        .from("user_memberships")
        .select("id")
        .eq("user_id", userId)
        .eq("is_current", true)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(1);
      if (selErr) throw selErr;
      const existing = existingRows?.[0] as { id: string | number } | undefined;

      if (existing) {
        const { error } = await supabaseAdmin
          .from("user_memberships")
          .update(patch)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        warnings.push(
          "user_memberships에 is_current=true row가 없어 새로 생성했습니다.",
        );
        const isCurrentPatch = patch.is_current;
        const insertPayload = {
          ...patch,
          user_id: userId,
          is_current:
            typeof isCurrentPatch === "boolean" ? isCurrentPatch : true,
        };
        const { error } = await supabaseAdmin
          .from("user_memberships")
          .insert(insertPayload);
        if (error) throw error;
      }
    }
  }

  // 4. user_introductions (assumed 1:1) — find-or-create
  if (body.introduction !== undefined) {
    const patch = pickWritable(body.introduction, INTRODUCTION_FIELDS);
    if (Object.keys(patch).length > 0) {
      applied.introduction = patch;
      const { data: existingRows, error: selErr } = await supabaseAdmin
        .from("user_introductions")
        .select("user_id")
        .eq("user_id", userId)
        .limit(1);
      if (selErr) throw selErr;
      const existing = existingRows?.[0] as { user_id: string } | undefined;

      if (existing) {
        const { error } = await supabaseAdmin
          .from("user_introductions")
          .update(patch)
          .eq("user_id", userId);
        if (error) throw error;
      } else {
        const { error } = await supabaseAdmin
          .from("user_introductions")
          .insert({ user_id: userId, ...patch });
        if (error) throw error;
      }
    }
  }

  // 5. user_resume_card_settings (PK = user_id) — upsert
  if (body.resumeCardSettings !== undefined) {
    const patch = pickWritable(
      body.resumeCardSettings,
      USER_RESUME_CARD_SETTINGS_FIELDS,
    );
    if (Object.keys(patch).length > 0) {
      applied.resumeCardSettings = patch;
      const { error } = await supabaseAdmin
        .from("user_resume_card_settings")
        .upsert(
          { user_id: userId, ...patch },
          { onConflict: "user_id" },
        );
      if (error) throw error;
    }
  }

  const bundle = await getResumeCardForCrew(legacyUserId);
  return { bundle, warnings, applied };
}

// ─────────────────────────────────────────────────────────────────────
// Site (singleton id=1)
// ─────────────────────────────────────────────────────────────────────
export async function getSiteResumeCard(): Promise<Row | null> {
  const { data, error } = await supabaseAdmin
    .from("site_resume_card_settings")
    .select("*")
    .eq("id", 1)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as Row | null;
}

export async function patchSiteResumeCard(body: unknown): Promise<Row | null> {
  const patch = pickWritable(body, SITE_RESUME_CARD_SETTINGS_FIELDS);
  if (Object.keys(patch).length === 0) {
    throw new ResumeCardError(400, "No updatable fields in body");
  }
  const { error } = await supabaseAdmin
    .from("site_resume_card_settings")
    .upsert({ id: 1, ...patch }, { onConflict: "id" });
  if (error) throw error;
  return getSiteResumeCard();
}

// ─────────────────────────────────────────────────────────────────────
// Per-organization
// ─────────────────────────────────────────────────────────────────────
export async function getOrganizationResumeCard(
  slug: OrganizationSlug,
): Promise<Row | null> {
  const { data, error } = await supabaseAdmin
    .from("organization_resume_card_settings")
    .select("*")
    .eq("organization_slug", slug)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as Row | null;
}

export async function patchOrganizationResumeCard(
  slug: OrganizationSlug,
  body: unknown,
): Promise<Row | null> {
  const patch = pickWritable(body, ORG_RESUME_CARD_SETTINGS_FIELDS);
  if (Object.keys(patch).length === 0) {
    throw new ResumeCardError(400, "No updatable fields in body");
  }
  const { error } = await supabaseAdmin
    .from("organization_resume_card_settings")
    .upsert(
      { organization_slug: slug, ...patch },
      { onConflict: "organization_slug" },
    );
  if (error) throw error;
  return getOrganizationResumeCard(slug);
}
