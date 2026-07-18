// Cluster1 Resume Card 확장 DTO 타입 정의.
// 상태 배지, 일정 신뢰도, 활동 완료율, 시즌 기록, 실무 성적 요약.

export type ResumeStatusCode =
  | "running"
  | "complete"
  | "on_rest"
  | "recharging"
  | "next_challenge";

export type ResumeStatusLabel =
  | "Running"
  | "Complete"
  | "On Rest"
  | "Recharging"
  | "Next Challenge";

export type ResumeStatus = {
  status: ResumeStatusCode;
  label: ResumeStatusLabel;
  isBadgeDimmed: boolean;
};

export type ScheduleReliability = {
  physicalWeeks: number;
  preRestWeeks: number;
  unapprovedActiveWeeks: number;
  approvedActiveWeeks: number;
  officialRestWeeks: number;
  rate: number;
};

export type ActivityCompletion = {
  availableActivities: number;
  completedActivities: number;
  rate: number;
};

export type PositionLabel =
  | "정규"
  | "심화(에이전트)"
  | "심화(파트장)"
  | "운영진(팀장)"
  | "운영진(앰배서더)"
  | "운영진(클럽장)";

export type ProgressStatus =
  | "진행 중"
  | "정상 완료"
  | "통합 휴식"
  | "활동 중단"
  | "정상 졸업";

export type ReviewStatus = "검수 중" | "승인 완료";

export type SeasonRecord = {
  year: string;
  seasonName: string;
  position: PositionLabel;
  progressStatus: ProgressStatus;
  approvedWeeks: number;
  totalWeeks: number;
  reviewStatus: ReviewStatus;
};

export type PracticalStats = {
  infoCount: number;
  experienceCount: number;
  abilityUnitCount: number;
  careerProjectCount: number;
};

export type Cluster1ResumeDto = {
  resumeStatus: ResumeStatus;
  scheduleReliability: ScheduleReliability;
  activityCompletion: ActivityCompletion;
  seasonRecords: SeasonRecord[];
  practicalStats: PracticalStats;
};
