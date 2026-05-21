// Browser-safe types for weekly_reviews (주차별 본인 회고).
//
// Canonical schema (Cluster4-card prerequisite, 2026-05-21):
//
//   weekly_reviews
//     id            uuid         PK
//     user_id       uuid         NOT NULL (FK -> user_profiles.user_id)
//     week_card_id  uuid         NOT NULL (FK -> weeks.id)
//     rating        smallint     NOT NULL (1..10 정수)
//     content       text         NOT NULL (1..200 chars)
//     created_at    timestamptz  NOT NULL DEFAULT now()
//     updated_at    timestamptz  NOT NULL DEFAULT now()
//
//   UNIQUE (user_id, week_card_id) — 한 사용자가 한 주차에 1건만.

export type WeeklyReviewRow = {
  id: string;
  user_id: string;
  week_card_id: string;
  rating: number;
  content: string;
  created_at: string | null;
  updated_at: string | null;
};

export type WeeklyReviewsListOptions = {
  userId: string;
  weekCardId?: string;
};

export type WeeklyReviewsListResult = {
  rows: WeeklyReviewRow[];
  available: boolean;
};

export type WeeklyReviewPatchRow = {
  id: string;
  rating: unknown;
  content: unknown;
};
