// Browser-safe types for career_records / career_projects / career_project_weeks
// (Cluster4-card Work Career 모달).
//
// Canonical schema (코드 기반 추정 — schema 파일 미발견. claudedocs/cluster4-card-final-data-model-design-20260521.md §4.5-4.7 기준):
//
//   career_projects   — 마스터 (admin 이 회사/프로젝트/감독자 정의)
//     id uuid PK
//     company_name, company_logo_url, job_position, project_name, project_description
//     line_code, line_name, output_links jsonb, output_images jsonb, company_homepage_links jsonb
//     secondary_info_deadline timestamptz
//     supervisor_name, supervisor_position, supervisor_department, supervisor_company, supervisor_profile_img
//     created_at
//
//   career_project_weeks — junction (project_id, week_id, is_active)
//     PK (project_id, week_id)
//
//   career_records — per-user
//     id uuid PK
//     user_id (FK user_profiles.user_id), week_id (FK weeks.id), project_id (FK career_projects.id)
//     enhancement_status text ('not_applicable' | 'pending' | 'enhanced' | 'failed')
//     grade text ('S' | 'A' | 'B' | 'C' | 'D' | null)
//     grade_points integer
//     career_code text
//     supervisor_* (legacy fallback — admin 은 본 컬럼을 write 하지 않음)
//     created_at
//
// 권장 제약 (별도 migration `2026-05-21_career_records_unique_user_week_project__HOLD.sql`):
//   UNIQUE (user_id, week_id, project_id)

export type CareerProjectRow = {
  id: string;
  company_name: string | null;
  company_logo_url: string | null;
  job_position: string | null;
  project_name: string | null;
  project_description: string | null;
  line_code: string | null;
  line_name: string | null;
  supervisor_name: string | null;
  supervisor_position: string | null;
  supervisor_department: string | null;
  supervisor_company: string | null;
  supervisor_profile_img: string | null;
};

export type CareerEnhancementStatus =
  | "not_applicable"
  | "pending"
  | "enhanced"
  | "failed";

export const CAREER_ENHANCEMENT_STATUSES: readonly CareerEnhancementStatus[] = [
  "not_applicable",
  "pending",
  "enhanced",
  "failed",
] as const;

export type CareerGrade = "S" | "A" | "B" | "C" | "D";

export const CAREER_GRADES: readonly CareerGrade[] = [
  "S",
  "A",
  "B",
  "C",
  "D",
] as const;

export type CareerRecordRow = {
  id: string;
  user_id: string;
  week_id: string;
  project_id: string;
  enhancement_status: CareerEnhancementStatus | null;
  grade: CareerGrade | null;
  grade_points: number | null;
  career_code: string | null;
  created_at: string | null;
  // join 결과 (admin UI 식별용)
  project: CareerProjectRow | null;
};

export type CareerRecordsListOptions = {
  userId: string;
  weekId?: string;
};

export type CareerRecordsListResult = {
  rows: CareerRecordRow[];
  available: boolean;
};

// admin upsert payload — (user_id, week_id, project_id) scope.
// id 가 있으면 update, 없으면 create.
export type CareerRecordUpsertInput = {
  id?: string | null;
  week_id: string;
  project_id: string;
  enhancement_status: CareerEnhancementStatus | null;
  grade: CareerGrade | null;
  grade_points: number | null;
  career_code: string | null;
};
