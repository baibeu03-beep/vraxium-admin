// Browser-safe types for the admin career(실무 경력) evaluation API.
// Must not import server-only modules here.

import type { CareerGrade, CareerRatingStatus } from "@/lib/careerGrade";

export type { CareerGrade, CareerRatingStatus } from "@/lib/careerGrade";

// 평가 단건 (upsert 결과).
export type CareerEvaluationDto = {
  id: string;
  lineTargetId: string;
  userId: string;
  grade: CareerGrade;
  gradePoints: number;
  evaluatedBy: string | null;
  evaluatedAt: string | null;
  updatedAt: string;
};

// 평가 탭 로드용 — career 라인의 대상자별 현재 평점.
export type CareerEvaluationTargetDto = {
  lineTargetId: string;
  weekId: string;
  userId: string;
  displayName: string | null;
  grade: CareerGrade | null;
  gradePoints: number | null;
  // 마감 무관 평가 결과 축. grade 미입력이면 "unevaluated".
  ratingStatus: CareerRatingStatus;
};

export type UpsertCareerEvaluationInput = {
  lineTargetId: string;
  userId: string;
  grade: CareerGrade;
};
