// Browser-safe types for user_activity_details (cluster4-card workinfo / workability / workexp).
//
// Canonical schema (코드 기반 추정 + db/migrations/2026-05-21_user_activity_details_add_rating.sql):
//
//   user_activity_details
//     id                    uuid PK DEFAULT gen_random_uuid()
//     user_id               uuid NOT NULL (FK auth.users.id or user_profiles.user_id)
//     week_id               uuid NOT NULL (FK weeks.id)
//     activity_type_id      text NOT NULL  -- info/comp-N/exp-N 자유 텍스트 키 (no FK)
//     sub_title             text NULL
//     output_links          jsonb NULL    -- [{desc, url}, ...] ≤5
//     growth_point          text NULL
//     image_urls            text[] DEFAULT '{}' (≤4)
//     image_captions        text[] DEFAULT '{}' (≤4, image_urls 와 인덱스 정렬)
//     growth_image_url      text NULL
//     growth_image_caption  text NULL
//     rating                smallint NULL CHECK (rating IS NULL OR rating BETWEEN 0 AND 10)
//                                          -- workexp 전용. info/ability 에서는 NULL.
//     created_at            timestamptz NOT NULL DEFAULT now()
//     updated_at            timestamptz NOT NULL DEFAULT now()
//
//   UNIQUE (user_id, week_id, activity_type_id)

export type UserActivityOutputLink = {
  desc: string | null;
  url: string;
};

export type UserActivityDetailRow = {
  id: string;
  user_id: string;
  week_id: string;
  activity_type_id: string;
  sub_title: string | null;
  output_links: UserActivityOutputLink[];
  growth_point: string | null;
  image_urls: string[];
  image_captions: string[];
  growth_image_url: string | null;
  growth_image_caption: string | null;
  rating: number | null;
  created_at: string | null;
  updated_at: string | null;
};

// 4개 모달이 같은 테이블을 공유하므로 activity_type_id 로 분류한다.
// 분류 규칙(코드 기반):
//   - work_info     : info 계열 키 (wisdom/essay/forum/infodesk/calendar/session/practical_lecture/community/etc_a)
//   - work_ability  : "comp-" prefix
//   - work_exp      : "exp-" prefix
//   - work_career   : "car-" prefix 또는 activity_types.cluster_id='practical_career' 키
// 분류 미상 row 는 work_info 로 fallback (admin UI 에서 명시적으로 노출).
export type UserActivityModalKey =
  | "work_info"
  | "work_ability"
  | "work_exp"
  | "work_career";

export const WORK_INFO_ACTIVITY_TYPE_IDS = [
  "wisdom",
  "essay",
  "forum",
  "infodesk",
  "calendar",
  "session",
  "practical_lecture",
  "community",
  "etc_a",
] as const;

export function classifyActivityType(typeId: string): UserActivityModalKey {
  const trimmed = (typeId ?? "").trim();
  if ((WORK_INFO_ACTIVITY_TYPE_IDS as readonly string[]).includes(trimmed)) {
    return "work_info";
  }
  if (/^comp[-_]/i.test(trimmed)) return "work_ability";
  if (/^exp[-_]/i.test(trimmed)) return "work_exp";
  if (/^car[-_]/i.test(trimmed)) return "work_career";
  return "work_info";
}

export type UserActivityDetailsListOptions = {
  userId: string;
  weekId?: string;
  // 특정 modal 종류만 조회. 미지정 시 전체.
  modal?: UserActivityModalKey;
};

export type UserActivityDetailsListResult = {
  rows: UserActivityDetailRow[];
  available: boolean;
};

// Admin upsert payload — id 가 있으면 update, 없으면 (user_id, week_id, activity_type_id)
// scope 에 upsert. rating 은 work_exp 만 사용.
export type UserActivityDetailUpsertInput = {
  id?: string | null;
  week_id: string;
  activity_type_id: string;
  sub_title: string | null;
  output_links: UserActivityOutputLink[];
  growth_point: string | null;
  image_urls: string[];
  image_captions: string[];
  growth_image_url: string | null;
  growth_image_caption: string | null;
  rating: number | null;
};
