// Browser-safe types for Cluster4 admin.
// Client components may import from here, so keep server-only modules out.

import type { ReputationKeywordRow } from "@/lib/reputationKeywordsTypes";
import type { WeeklyReputationRow } from "@/lib/weeklyReputationsTypes";
import type { WeeklyReviewRow, WeeklyReviewPatchRow } from "@/lib/weeklyReviewsTypes";
import type {
  WeeklyColleagueRow,
  WeeklyColleaguePatchRow,
} from "@/lib/weeklyColleaguesTypes";

export type {
  ReputationKeywordRow,
  WeeklyReputationRow,
  WeeklyReviewRow,
  WeeklyColleagueRow,
};

export type SeasonRow = Record<string, unknown>;
export type WeekRow = Record<string, unknown>;
export type UserSeasonHistoryRow = Record<string, unknown>;

// Peer-review pivot (2026-05-21): season_reputations 는 (reviewer_id, target_user_id,
// season_history_id) peer-review row. Admin Cluster4 페이지는 "받은 시즌 평판" —
// 현재 관리 중인 user 가 target_user_id 인 row 만 표시.
export type ReceivedSeasonReputationRow = {
  id: string;
  reviewer_id: string;
  target_user_id: string;
  season_history_id: string | null;
  rating: number | null;
  content: string | null;
  keyword_1: string | null;
  keyword_2: string | null;
  keyword_3: string | null;
  created_at: string | null;
  updated_at: string | null;
  reviewer: {
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  } | null;
};

export type Cluster4Bundle = {
  legacyUserId: string;
  userId: string | null;
  seasons: SeasonRow[];
  weeks: WeekRow[];
  userSeasonHistories: UserSeasonHistoryRow[];
  receivedSeasonReputations: ReceivedSeasonReputationRow[];
  reputationKeywords: ReputationKeywordRow[];
  receivedWeeklyReputations: WeeklyReputationRow[];
  weeklyReviews: WeeklyReviewRow[];
  weeklyColleagues: WeeklyColleagueRow[];
  tablesAvailable: {
    seasons: boolean;
    weeks: boolean;
    userSeasonHistories: boolean;
    seasonReputations: boolean;
    reputationKeywords: boolean;
    weeklyReputations: boolean;
    weeklyReviews: boolean;
    weeklyColleagues: boolean;
  };
};

export type Cluster4UserSeasonHistoryPatchRow = {
  id: string;
  rating: unknown;
  review: unknown;
};

// Admin 은 peer-review row 의 reviewer/target/season_history 관계는 변경하지 않는다.
// 수정 가능한 컬럼은 본문/점수/키워드뿐. id 기준 update.
export type Cluster4SeasonReputationPatchRow = {
  id: string;
  rating: unknown;
  content: unknown;
  keyword_1: unknown;
  keyword_2: unknown;
  keyword_3: unknown;
};

export type Cluster4WeeklyReputationPatchRow = {
  id: string;
  rating: unknown;
  content: unknown;
  keyword: unknown;
};

export type { WeeklyReviewPatchRow, WeeklyColleaguePatchRow };

export type Cluster4PatchBody = {
  userSeasonHistories?: Cluster4UserSeasonHistoryPatchRow[];
  seasonReputations?: Cluster4SeasonReputationPatchRow[];
  weeklyReputations?: Cluster4WeeklyReputationPatchRow[];
  weeklyReviews?: WeeklyReviewPatchRow[];
  weeklyColleagues?: WeeklyColleaguePatchRow[];
};

export type Cluster4ApplySummary = {
  userSeasonHistories?: { updated: number; ids: string[] };
  seasonReputations?: { updated: number; ids: string[] };
  weeklyReputations?: { updated: number; ids: string[] };
  weeklyReviews?: { updated: number; ids: string[] };
  weeklyColleagues?: { updated: number; ids: string[] };
};

// DELETE 분기에서 사용. id 기반 단일 row 삭제.
export type Cluster4DeleteResource =
  | "seasonReputation"
  | "weeklyReputation"
  | "weeklyReview"
  | "weeklyColleague";
