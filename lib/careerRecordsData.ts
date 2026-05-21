// Server-only data layer for career_records (+ project join).
// Admin Cluster4Editor Work Career sub-tab 에서 사용.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  CAREER_ENHANCEMENT_STATUSES,
  CAREER_GRADES,
  type CareerEnhancementStatus,
  type CareerGrade,
  type CareerProjectRow,
  type CareerRecordRow,
  type CareerRecordUpsertInput,
  type CareerRecordsListOptions,
  type CareerRecordsListResult,
} from "@/lib/careerRecordsTypes";

const RECORD_SELECT =
  "id,user_id,week_id,project_id,enhancement_status,grade,grade_points,career_code,created_at";

const PROJECT_SELECT =
  "id,company_name,company_logo_url,job_position,project_name,project_description,line_code,line_name,supervisor_name,supervisor_position,supervisor_department,supervisor_company,supervisor_profile_img";

function isMissingRelationError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42P01") return true;
  return (
    typeof error.message === "string" && /does not exist/i.test(error.message)
  );
}

function toNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function normalizeProject(raw: Record<string, unknown>): CareerProjectRow {
  return {
    id: String(raw.id ?? ""),
    company_name: toNullableString(raw.company_name),
    company_logo_url: toNullableString(raw.company_logo_url),
    job_position: toNullableString(raw.job_position),
    project_name: toNullableString(raw.project_name),
    project_description: toNullableString(raw.project_description),
    line_code: toNullableString(raw.line_code),
    line_name: toNullableString(raw.line_name),
    supervisor_name: toNullableString(raw.supervisor_name),
    supervisor_position: toNullableString(raw.supervisor_position),
    supervisor_department: toNullableString(raw.supervisor_department),
    supervisor_company: toNullableString(raw.supervisor_company),
    supervisor_profile_img: toNullableString(raw.supervisor_profile_img),
  };
}

function normalizeRecord(
  raw: Record<string, unknown>,
  projectMap: Map<string, CareerProjectRow>,
): CareerRecordRow {
  const projectId = String(raw.project_id ?? "");
  const enhancementStatus = (() => {
    const value = toNullableString(raw.enhancement_status);
    if (value && CAREER_ENHANCEMENT_STATUSES.includes(value as CareerEnhancementStatus)) {
      return value as CareerEnhancementStatus;
    }
    return null;
  })();
  const grade = (() => {
    const value = toNullableString(raw.grade);
    if (value && CAREER_GRADES.includes(value as CareerGrade)) {
      return value as CareerGrade;
    }
    return null;
  })();

  return {
    id: String(raw.id ?? ""),
    user_id: String(raw.user_id ?? ""),
    week_id: String(raw.week_id ?? ""),
    project_id: projectId,
    enhancement_status: enhancementStatus,
    grade,
    grade_points: toNullableNumber(raw.grade_points),
    career_code: toNullableString(raw.career_code),
    created_at: typeof raw.created_at === "string" ? raw.created_at : null,
    project: projectMap.get(projectId) ?? null,
  };
}

export async function listCareerRecords(
  options: CareerRecordsListOptions,
): Promise<CareerRecordsListResult> {
  const userId = String(options.userId ?? "").trim();
  if (!userId) {
    throw new Error("listCareerRecords: userId is required.");
  }

  let query = supabaseAdmin
    .from("career_records")
    .select(RECORD_SELECT)
    .eq("user_id", userId)
    .order("week_id", { ascending: true })
    .order("created_at", { ascending: true });

  const weekId = options.weekId ? String(options.weekId).trim() : "";
  if (weekId) query = query.eq("week_id", weekId);

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      console.warn(
        "[career_records] table not found; returning empty result.",
        { message: error.message },
      );
      return { rows: [], available: false };
    }
    console.error("[career_records] query failed", { message: error.message });
    throw new Error(error.message);
  }

  const rawRows = (data ?? []) as Record<string, unknown>[];
  if (rawRows.length === 0) {
    return { rows: [], available: true };
  }

  // project join 을 한 번에.
  const projectIds = Array.from(
    new Set(rawRows.map((row) => String(row.project_id ?? "")).filter(Boolean)),
  );
  const projectMap = new Map<string, CareerProjectRow>();
  if (projectIds.length > 0) {
    const { data: projects, error: projectError } = await supabaseAdmin
      .from("career_projects")
      .select(PROJECT_SELECT)
      .in("id", projectIds);
    if (projectError) {
      if (!isMissingRelationError(projectError)) {
        console.error("[career_records] project join failed", {
          message: projectError.message,
        });
        throw new Error(projectError.message);
      }
    }
    for (const project of (projects ?? []) as Record<string, unknown>[]) {
      const normalized = normalizeProject(project);
      projectMap.set(normalized.id, normalized);
    }
  }

  const rows = rawRows.map((row) => normalizeRecord(row, projectMap));
  return { rows, available: true };
}

export class CareerRecordsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CareerRecordsError";
  }
}

function normalizeEnhancementStatus(value: unknown): CareerEnhancementStatus | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value === "string" &&
    CAREER_ENHANCEMENT_STATUSES.includes(value as CareerEnhancementStatus)
  ) {
    return value as CareerEnhancementStatus;
  }
  throw new CareerRecordsError(
    400,
    `enhancement_status 는 ${CAREER_ENHANCEMENT_STATUSES.join(" / ")} 중 하나여야 합니다.`,
  );
}

function normalizeGrade(value: unknown): CareerGrade | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && CAREER_GRADES.includes(value as CareerGrade)) {
    return value as CareerGrade;
  }
  throw new CareerRecordsError(
    400,
    `grade 는 ${CAREER_GRADES.join(" / ")} 중 하나여야 합니다.`,
  );
}

function normalizeGradePoints(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new CareerRecordsError(
      400,
      "grade_points 는 0 이상의 정수여야 합니다.",
    );
  }
  return n;
}

function normalizeNullableShortText(
  value: unknown,
  max: number,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  const stringValue = typeof value === "string" ? value : String(value);
  const trimmed = stringValue.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new CareerRecordsError(400, `${field} 는 최대 ${max} 자입니다.`);
  }
  return trimmed;
}

// Admin upsert by (user_id, week_id, project_id). UNIQUE 제약이 적용된 후라면
// onConflict 옵션이 정상 작동하지만, 적용 전에는 fallback 으로 select-update / insert 분기.
export async function upsertCareerRecord(
  userId: string,
  input: CareerRecordUpsertInput,
): Promise<CareerRecordRow> {
  const trimmedUser = String(userId ?? "").trim();
  if (!trimmedUser) {
    throw new CareerRecordsError(400, "userId is required.");
  }
  const weekId = String(input.week_id ?? "").trim();
  if (!weekId) {
    throw new CareerRecordsError(400, "week_id is required.");
  }
  const projectId = String(input.project_id ?? "").trim();
  if (!projectId) {
    throw new CareerRecordsError(400, "project_id is required.");
  }

  const enhancementStatus = normalizeEnhancementStatus(input.enhancement_status);
  const grade = normalizeGrade(input.grade);
  const gradePoints = normalizeGradePoints(input.grade_points);
  const careerCode = normalizeNullableShortText(input.career_code, 50, "career_code");

  const explicitId = String(input.id ?? "").trim();

  // 1) explicit id 가 있으면 ownership 확인 후 update.
  if (explicitId) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("career_records")
      .select("id,user_id,week_id,project_id")
      .eq("id", explicitId)
      .maybeSingle();
    if (existingError) {
      if (isMissingRelationError(existingError)) {
        throw new CareerRecordsError(404, "career_records table not found.");
      }
      throw new CareerRecordsError(500, existingError.message);
    }
    if (!existing) {
      throw new CareerRecordsError(404, "career_record not found.");
    }
    if ((existing as { user_id?: string }).user_id !== trimmedUser) {
      throw new CareerRecordsError(
        403,
        "career_record does not belong to this crew.",
      );
    }
    const { data, error } = await supabaseAdmin
      .from("career_records")
      .update({
        week_id: weekId,
        project_id: projectId,
        enhancement_status: enhancementStatus,
        grade,
        grade_points: gradePoints,
        career_code: careerCode,
      })
      .eq("id", explicitId)
      .eq("user_id", trimmedUser)
      .select(RECORD_SELECT)
      .single();
    if (error || !data) {
      throw new CareerRecordsError(
        500,
        error?.message ?? "Failed to update career_record.",
      );
    }
    return normalizeRecord(
      data as Record<string, unknown>,
      new Map(),
    );
  }

  // 2) (user_id, week_id, project_id) 로 기존 row 검색 후 update or insert.
  const { data: scopeRow, error: scopeError } = await supabaseAdmin
    .from("career_records")
    .select("id")
    .eq("user_id", trimmedUser)
    .eq("week_id", weekId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (scopeError) {
    if (isMissingRelationError(scopeError)) {
      throw new CareerRecordsError(404, "career_records table not found.");
    }
    // maybeSingle 이 multi-row 일 때 에러 발생 — UNIQUE 미적용 환경에서 발생 가능.
    if (/multiple rows/i.test(scopeError.message ?? "")) {
      throw new CareerRecordsError(
        409,
        "동일 scope(user_id, week_id, project_id)에 row 가 다중 존재합니다. UNIQUE 제약 적용 전 cleanup 이 필요합니다.",
      );
    }
    throw new CareerRecordsError(500, scopeError.message);
  }

  if (scopeRow) {
    const id = (scopeRow as { id?: string }).id ?? "";
    const { data, error } = await supabaseAdmin
      .from("career_records")
      .update({
        enhancement_status: enhancementStatus,
        grade,
        grade_points: gradePoints,
        career_code: careerCode,
      })
      .eq("id", id)
      .eq("user_id", trimmedUser)
      .select(RECORD_SELECT)
      .single();
    if (error || !data) {
      throw new CareerRecordsError(
        500,
        error?.message ?? "Failed to update career_record.",
      );
    }
    return normalizeRecord(data as Record<string, unknown>, new Map());
  }

  const { data, error } = await supabaseAdmin
    .from("career_records")
    .insert({
      user_id: trimmedUser,
      week_id: weekId,
      project_id: projectId,
      enhancement_status: enhancementStatus,
      grade,
      grade_points: gradePoints,
      career_code: careerCode,
    })
    .select(RECORD_SELECT)
    .single();
  if (error || !data) {
    throw new CareerRecordsError(
      500,
      error?.message ?? "Failed to insert career_record.",
    );
  }
  return normalizeRecord(data as Record<string, unknown>, new Map());
}

export async function deleteCareerRecord(
  userId: string,
  rowId: string,
): Promise<string> {
  const trimmedUser = String(userId ?? "").trim();
  const id = String(rowId ?? "").trim();
  if (!trimmedUser) {
    throw new CareerRecordsError(400, "userId is required.");
  }
  if (!id) {
    throw new CareerRecordsError(400, "career_record id is required.");
  }

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("career_records")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (lookupError) {
    if (isMissingRelationError(lookupError)) {
      throw new CareerRecordsError(404, "career_record not found.");
    }
    throw new CareerRecordsError(500, lookupError.message);
  }
  if (!existing) {
    throw new CareerRecordsError(404, "career_record not found.");
  }
  if ((existing as { user_id?: string }).user_id !== trimmedUser) {
    throw new CareerRecordsError(
      403,
      "career_record does not belong to this crew.",
    );
  }

  const { error } = await supabaseAdmin
    .from("career_records")
    .delete()
    .eq("id", id)
    .eq("user_id", trimmedUser);
  if (error) {
    throw new CareerRecordsError(500, error.message);
  }
  return id;
}
