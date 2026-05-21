// Browser-safe types for weekly_colleagues (주차별 연계 동료).
//
// Canonical schema (Cluster4-card prerequisite, 2026-05-21):
//
//   weekly_colleagues
//     id            uuid         PK
//     user_id       uuid         NOT NULL (FK -> user_profiles.user_id)
//     week_card_id  uuid         NOT NULL (FK -> weeks.id)
//     colleague_id  uuid         NOT NULL (FK -> user_profiles.user_id)
//     rank          smallint     NOT NULL (1..3)
//     message       text         NULL    (NULL or 0..200 chars)
//     created_at    timestamptz  NOT NULL DEFAULT now()
//     updated_at    timestamptz  NOT NULL DEFAULT now()
//
//   UNIQUE (user_id, week_card_id, colleague_id)
//   CHECK user_id <> colleague_id

export type WeeklyColleagueRow = {
  id: string;
  user_id: string;
  week_card_id: string;
  colleague_id: string;
  rank: number;
  message: string | null;
  created_at: string | null;
  updated_at: string | null;
  // Admin UI 에서 동료 이름 / 조직 표시용 join 정보.
  colleague: {
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  } | null;
};

export type WeeklyColleaguesListOptions = {
  userId: string;
  weekCardId?: string;
};

export type WeeklyColleaguesListResult = {
  rows: WeeklyColleagueRow[];
  available: boolean;
};

export type WeeklyColleaguePatchRow = {
  id: string;
  rank: unknown;
  message: unknown;
};
