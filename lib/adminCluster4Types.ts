// Browser-safe types for Cluster4 admin.
// Client components may import from here, so keep server-only modules out.

import type { ReputationKeywordRow } from "@/lib/reputationKeywordsTypes";
import type { WeeklyReputationRow } from "@/lib/weeklyReputationsTypes";
import type { WeeklyReviewRow, WeeklyReviewPatchRow } from "@/lib/weeklyReviewsTypes";
import type {
  WeeklyColleagueRow,
  WeeklyColleaguePatchRow,
} from "@/lib/weeklyColleaguesTypes";
import type {
  ActivityTypeClusterMap,
  UserActivityDetailRow,
  UserActivityDetailUpsertInput,
  UserActivityModalKey,
} from "@/lib/userActivityDetailsTypes";
import type {
  CareerRecordRow,
  CareerRecordUpsertInput,
} from "@/lib/careerRecordsTypes";
import type { Cluster4LinePartType } from "@/lib/cluster4LinesTypes";
import type { Cluster4HubEditWindowKey } from "@/lib/cluster4LinePermission";

export type {
  ReputationKeywordRow,
  WeeklyReputationRow,
  WeeklyReviewRow,
  WeeklyColleagueRow,
  ActivityTypeClusterMap,
  UserActivityDetailRow,
  UserActivityDetailUpsertInput,
  UserActivityModalKey,
  CareerRecordRow,
  CareerRecordUpsertInput,
};

// Snapshot of a cluster4_line_targets row joined with cluster4_lines.is_active +
// submission_opens_at / submission_closes_at. Browser-safe shape; consumed by
// canEditCluster4Line in lib/cluster4LinePermission.ts.
export type Cluster4LineTargetSnapshot = {
  lineTargetId: string;
  lineId: string;
  weekId: string;
  partType: Cluster4LinePartType;
  targetMode: "user" | "rule";
  targetUserId: string | null;
  line: {
    isActive: boolean;
    submissionOpensAt: string;
    submissionClosesAt: string;
    mainTitle: string;
  };
};

// Snapshot of a user_edit_windows row for one of the 4 cluster4.work_* keys.
// null = no row exists for this resource_key.
export type Cluster4HubEditWindowSnapshot = {
  resourceKey: Cluster4HubEditWindowKey;
  openedAt: string;
  expiresAt: string;
} | null;

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
  // 4개 모달 — user_activity_details 단일 테이블을 classifyActivityType 기준으로 그룹핑.
  userActivityDetails: UserActivityDetailRow[];
  // Work Career 모달 — career_records (+ project join).
  careerRecords: CareerRecordRow[];
  // activity_types(id → cluster_id) lookup. 클라이언트는 이 map 으로 row 의
  // activity_type_id 를 cluster_id 로 변환 후 modal(work_ability/exp/career) 을
  // 분류한다 (canonical 분류 기준). activity_types 테이블 부재 시 빈 객체.
  activityTypesClusterMap: ActivityTypeClusterMap;
  // Cluster4 4허브 (info / competency / experience / career) 라인 시스템의 권한
  // snapshot. ActivityTab 의 per-row canEdit 은 이 두 필드 + canEditCluster4Line /
  // evaluateCluster4HubEdit 헬퍼로 결정된다 (legacy Boolean(bundle.userId) 대체).
  cluster4LineTargets: Cluster4LineTargetSnapshot[];
  cluster4HubEditWindows: Record<
    Cluster4HubEditWindowKey,
    Cluster4HubEditWindowSnapshot
  >;
  tablesAvailable: {
    seasons: boolean;
    weeks: boolean;
    userSeasonHistories: boolean;
    seasonReputations: boolean;
    reputationKeywords: boolean;
    weeklyReputations: boolean;
    weeklyReviews: boolean;
    weeklyColleagues: boolean;
    userActivityDetails: boolean;
    careerRecords: boolean;
    activityTypes: boolean;
    cluster4LineTargets: boolean;
    userEditWindows: boolean;
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

// Work Info/Ability/Exp 공통 upsert payload. modal 분류는 server 가 activity_type_id 로
// 추론하지만, Front 가 의도한 분류를 명시적으로 보낼 수도 있도록 optional `modal` 포함.
export type Cluster4UserActivityDetailPatchRow = UserActivityDetailUpsertInput & {
  // optional. 명시되면 rating 정책 일치 검증에만 사용 (DB 컬럼에 저장 X).
  modal?: UserActivityModalKey;
};

export type Cluster4CareerRecordPatchRow = CareerRecordUpsertInput;

export type Cluster4PatchBody = {
  userSeasonHistories?: Cluster4UserSeasonHistoryPatchRow[];
  seasonReputations?: Cluster4SeasonReputationPatchRow[];
  weeklyReputations?: Cluster4WeeklyReputationPatchRow[];
  weeklyReviews?: WeeklyReviewPatchRow[];
  weeklyColleagues?: WeeklyColleaguePatchRow[];
  userActivityDetails?: Cluster4UserActivityDetailPatchRow[];
  careerRecords?: Cluster4CareerRecordPatchRow[];
};

export type Cluster4ApplySummary = {
  userSeasonHistories?: { updated: number; ids: string[] };
  seasonReputations?: { updated: number; ids: string[] };
  weeklyReputations?: { updated: number; ids: string[] };
  weeklyReviews?: { updated: number; ids: string[] };
  weeklyColleagues?: { updated: number; ids: string[] };
  userActivityDetails?: { upserted: number; ids: string[] };
  careerRecords?: { upserted: number; ids: string[] };
};

// DELETE 분기에서 사용. id 기반 단일 row 삭제.
export type Cluster4DeleteResource =
  | "seasonReputation"
  | "weeklyReputation"
  | "weeklyReview"
  | "weeklyColleague"
  | "userActivityDetail"
  | "careerRecord";
