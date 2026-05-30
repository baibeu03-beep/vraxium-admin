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
import type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";
import type { Cluster4OutputImage } from "@/lib/cluster4OutputImages";

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

// 어드민 활동 편집의 새 SoT 단위 — cluster4_line_targets(user-mode) 1행에 매달린
// cluster4_line_submissions 본문(없으면 null). user_activity_details 를 대체한다.
// 편집은 line_target_id 기준이며, target 이 없으면 submission 을 만들 수 없다(라인 개설/배정 선행).
export type Cluster4AdminSubmissionRow = {
  lineTargetId: string;
  lineId: string;
  weekId: string;
  partType: Cluster4LinePartType;
  mainTitle: string;
  // info sub-line 식별자 (activity_types.id). info 외 part 는 보통 null.
  activityTypeId: string | null;
  submissionOpensAt: string;
  submissionClosesAt: string;
  isActive: boolean;
  // 제출 본문. 미제출 슬롯은 null.
  submission: {
    id: string;
    subtitle: string | null;
    growthPoint: string | null;
    outputLinks: Cluster4OutputLink[];
    outputImages: Cluster4OutputImage[];
    submittedAt: string;
    updatedAt: string;
  } | null;
};

// 어드민 submission upsert 입력 — line_target_id 기준. rating 은 이번 단계 제외(보류).
// 작성기간(submission_closes_at)은 검사하지 않는다 (운영자 상시 편집).
export type Cluster4AdminSubmissionUpsertInput = {
  lineTargetId: string;
  subtitle?: string | null;
  growthPoint?: string | null;
  outputLinks?: Cluster4OutputLink[];
  outputImages?: Cluster4OutputImage[];
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
  // ActivityTab 전환용 — user-mode line target + 조인된 submission 본문 슬롯.
  // (staging) 배선 단계에서 항상 채워지며, 그 전까지는 optional 로 둔다.
  cluster4LineSubmissions?: Cluster4AdminSubmissionRow[];
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
    // (staging) 배선 단계에서 항상 채워진다.
    cluster4LineSubmissions?: boolean;
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

// 어드민 submission 편집 payload — line_target_id 기준 upsert. rating 미포함.
export type Cluster4LineSubmissionPatchRow = Cluster4AdminSubmissionUpsertInput;

export type Cluster4PatchBody = {
  userSeasonHistories?: Cluster4UserSeasonHistoryPatchRow[];
  seasonReputations?: Cluster4SeasonReputationPatchRow[];
  weeklyReputations?: Cluster4WeeklyReputationPatchRow[];
  weeklyReviews?: WeeklyReviewPatchRow[];
  weeklyColleagues?: WeeklyColleaguePatchRow[];
  userActivityDetails?: Cluster4UserActivityDetailPatchRow[];
  careerRecords?: Cluster4CareerRecordPatchRow[];
  cluster4LineSubmissions?: Cluster4LineSubmissionPatchRow[];
};

export type Cluster4ApplySummary = {
  userSeasonHistories?: { updated: number; ids: string[] };
  seasonReputations?: { updated: number; ids: string[] };
  weeklyReputations?: { updated: number; ids: string[] };
  weeklyReviews?: { updated: number; ids: string[] };
  weeklyColleagues?: { updated: number; ids: string[] };
  userActivityDetails?: { upserted: number; ids: string[] };
  careerRecords?: { upserted: number; ids: string[] };
  cluster4LineSubmissions?: { upserted: number; ids: string[] };
};

// DELETE 분기에서 사용. id 기반 단일 row 삭제.
export type Cluster4DeleteResource =
  | "seasonReputation"
  | "weeklyReputation"
  | "weeklyReview"
  | "weeklyColleague"
  | "userActivityDetail"
  | "careerRecord"
  | "cluster4LineSubmission";
