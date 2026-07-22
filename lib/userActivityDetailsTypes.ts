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
  rating: number | null;
  created_at: string | null;
  updated_at: string | null;
};

// 4개 모달이 같은 테이블을 공유하므로 activity_type_id 로 분류한다.
// 분류 규칙 (우선순위 순):
//   1) work_info 고정 ID 목록 (wisdom/essay/forum/infodesk/calendar/session/
//      practical_lecture/community/etc_a)
//   2) activity_types.cluster_id 기반 lookup (canonical — Career-Resume 프론트가
//      쓰는 source of truth):
//        practical_competency → work_ability
//        practical_experience → work_exp
//        practical_career     → work_career
//   3) Legacy prefix fallback (cluster map 부재 또는 매칭 실패 시):
//        comp[-_]  → work_ability
//        exp[-_]   → work_exp
//        car[-_]   → work_career
//   4) 그 외 미상 → work_info
export type UserActivityModalKey =
  | "work_info"
  | "work_ability"
  | "work_exp"
  | "work_career";

// 정본 9종(고정). 신규 등록 info 라인('info_*')은 이 목록에 없고 아래 cluster_id 조회
//   (practical_info → work_info)로 분류된다. 이 상수는 "정본 9종" 의미로만 쓴다 —
//   info 라인 유니버스는 lib/adminInfoLineCatalog.listInfoLineCatalog 가 SoT다.
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

// activity_types.id → activity_types.cluster_id 매핑. 서버 fetch 결과를
// 클라이언트로 흘려보내기 위해 Record (JSON-serializable) 로 정의.
export type ActivityTypeClusterMap = Record<string, string>;

// activity_types.cluster_id 값 → 4개 모달 매핑 (canonical).
// Career-Resume Cluster4CardContent.tsx 의 분기와 동일 (line 1130-1142).
const CLUSTER_ID_TO_MODAL: Record<string, UserActivityModalKey> = {
  practical_info: "work_info",
  practical_competency: "work_ability",
  practical_experience: "work_exp",
  practical_career: "work_career",
};

export function classifyActivityType(
  typeId: string,
  clusterMap?: ActivityTypeClusterMap | null,
): UserActivityModalKey {
  const trimmed = (typeId ?? "").trim();
  if ((WORK_INFO_ACTIVITY_TYPE_IDS as readonly string[]).includes(trimmed)) {
    return "work_info";
  }
  if (clusterMap) {
    const clusterId = clusterMap[trimmed];
    const mapped = clusterId ? CLUSTER_ID_TO_MODAL[clusterId] : undefined;
    if (mapped) return mapped;
  }
  // Legacy prefix fallback: activity_types row 가 아직 없거나 cluster_id 가
  // 비표준일 때를 위해 유지 (테스트용 comp-1 / exp-1 / car-1 row 호환).
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
//
// Partial-update semantics (2026-05-22):
//   - week_id / activity_type_id 는 row 식별 키이므로 INSERT/UPDATE 양쪽 모두 필수.
//   - 컨텐츠 필드(sub_title, growth_point, output_links, image_urls, image_captions,
//     rating) 는 optional:
//       · 키 부재(undefined) → 기존 DB 값 그대로 보존 (no-op).
//       · 키 존재 + 값 → explicit 설정 (null/""/[] 도 explicit 삭제로 인정).
//   - 이미지 페어(image_urls / image_captions) 는 한쪽만 제공돼도 OK. 서버가
//     누락된 쪽을 기존 DB 값으로 채워 정합 후 정규화한다.
//   - INSERT 경로(기존 row 부재)에서는 누락된 optional 필드에 default 적용
//     (sub_title=null, output_links=[], image_urls=[], ... rating=null).
export type UserActivityDetailUpsertInput = {
  id?: string | null;
  week_id: string;
  activity_type_id: string;
  sub_title?: string | null;
  output_links?: UserActivityOutputLink[];
  growth_point?: string | null;
  image_urls?: string[];
  image_captions?: string[];
  rating?: number | null;
};
