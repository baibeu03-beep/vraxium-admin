// Browser-safe types for weekly_reputations (peer-review row).
//
// Canonical schema (peer-review pivot, 2026-05-21):
//
//   weekly_reputations
//     id              uuid         PK
//     reviewer_id     uuid         NOT NULL (FK -> user_profiles.user_id)
//     target_user_id  uuid         NOT NULL (FK -> user_profiles.user_id)
//     week_card_id    uuid         NOT NULL (FK -> weeks.id)
//     rating          numeric(3,1) NOT NULL (0..10 half-step)
//     content         text         NOT NULL (1..100 chars)
//     keyword         text         NOT NULL (free text; UI 는 reputation_keywords 후보에서 선택)
//     created_at      timestamptz  NOT NULL DEFAULT now()
//     updated_at      timestamptz  NOT NULL DEFAULT now()
//
// 정책:
//   - Admin 의 Cluster4 페이지는 "받은 주간 평판" — target_user_id = 현재 관리 중인 user.
//   - reviewer_id 기준 조회는 기본 섹션이 아님.
//   - keyword 컬럼은 FK 가 아니므로 reputation_keywords 가 변경되어도 history 가 깨지지 않음.

export type WeeklyReputationRow = {
  id: string;
  reviewer_id: string;
  target_user_id: string;
  week_card_id: string;
  rating: number;
  content: string;
  keyword: string;
  created_at: string | null;
  updated_at: string | null;
  // Admin UI 에서 reviewer 식별을 위해 user_profiles 에서 join 한 정보.
  reviewer: {
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  } | null;
};

export type WeeklyReputationsListOptions = {
  // required — 본 단계 admin 의 "받은 주간 평판" 조회 기준.
  targetUserId: string;
  // optional filters.
  weekCardId?: string;
};

export type WeeklyReputationsListResult = {
  rows: WeeklyReputationRow[];
  available: boolean;
};
