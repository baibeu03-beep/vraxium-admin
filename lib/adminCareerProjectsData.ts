import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import type {
  CareerProjectDto,
  CareerProjectUpsertInput,
  CareerProjectWeekStateDto,
  ListCareerProjectsResult,
  ListCareerProjectWeeksResult,
} from "@/lib/adminCareerProjectsTypes";

// /admin/career-projects 전용 server-only 데이터 레이어.
// canonical 테이블: public.career_projects, public.career_project_weeks.
// 권한: read 는 ADMIN_READ_ROLES 게이트, write 는 admin_users.role='owner' 게이트.
// 본 모듈은 게이트 통과 후 호출된다는 전제로 동작한다 (게이트는 API 라우트가 책임).

export class CareerProjectError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CareerProjectError";
    this.status = status;
  }
}

type CareerProjectRow = {
  id: string;
  company_name: string | null;
  company_logo_url: string | null;
  job_position: string | null;
  project_name: string | null;
  project_description: string | null;
  line_code: string | null;
  line_name: string | null;
  output_links: unknown;
  output_images: unknown;
  company_homepage_links: unknown;
  secondary_info_deadline: string | null;
  supervisor_name: string | null;
  supervisor_position: string | null;
  supervisor_department: string | null;
  supervisor_company: string | null;
  supervisor_profile_img: string | null;
  created_at: string;
  updated_at: string;
};

const PROJECT_SELECT =
  "id,company_name,company_logo_url,job_position,project_name,project_description,line_code,line_name,output_links,output_images,company_homepage_links,secondary_info_deadline,supervisor_name,supervisor_position,supervisor_department,supervisor_company,supervisor_profile_img,created_at,updated_at";

function escapeForIlike(value: string) {
  return value.replace(/[%_,()]/g, "").trim();
}

function toDto(row: CareerProjectRow, weekCount: number): CareerProjectDto {
  return {
    id: row.id,
    companyName: row.company_name,
    companyLogoUrl: row.company_logo_url,
    jobPosition: row.job_position,
    projectName: row.project_name,
    projectDescription: row.project_description,
    lineCode: row.line_code,
    lineName: row.line_name,
    outputLinks: row.output_links ?? [],
    outputImages: row.output_images ?? [],
    companyHomepageLinks: row.company_homepage_links ?? [],
    secondaryInfoDeadline: row.secondary_info_deadline,
    supervisorName: row.supervisor_name,
    supervisorPosition: row.supervisor_position,
    supervisorDepartment: row.supervisor_department,
    supervisorCompany: row.supervisor_company,
    supervisorProfileImg: row.supervisor_profile_img,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    weekCount,
  };
}

function normalizeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new CareerProjectError(400, "Text fields must be string or null");
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeDeadline(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new CareerProjectError(
      400,
      "secondary_info_deadline must be ISO string or null",
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new CareerProjectError(
      400,
      "secondary_info_deadline must be a valid date string",
    );
  }
  return parsed.toISOString();
}

function buildPayload(input: CareerProjectUpsertInput) {
  return {
    company_name: normalizeText(input.companyName),
    company_logo_url: normalizeText(input.companyLogoUrl),
    job_position: normalizeText(input.jobPosition),
    project_name: normalizeText(input.projectName),
    project_description: normalizeText(input.projectDescription),
    line_code: normalizeText(input.lineCode),
    line_name: normalizeText(input.lineName),
    output_links: input.outputLinks ?? [],
    output_images: input.outputImages ?? [],
    company_homepage_links: input.companyHomepageLinks ?? [],
    secondary_info_deadline: normalizeDeadline(input.secondaryInfoDeadline),
    supervisor_name: normalizeText(input.supervisorName),
    supervisor_position: normalizeText(input.supervisorPosition),
    supervisor_department: normalizeText(input.supervisorDepartment),
    supervisor_company: normalizeText(input.supervisorCompany),
    supervisor_profile_img: normalizeText(input.supervisorProfileImg),
  };
}

// 여러 프로젝트 id 에 대한 연결된 주차 수를 한 번의 쿼리로 묶어 카운트한다.
async function fetchWeekCounts(projectIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (projectIds.length === 0) return counts;
  const { data, error } = await supabaseAdmin
    .from("career_project_weeks")
    .select("project_id")
    .in("project_id", projectIds);
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
  for (const row of (data ?? []) as Array<{ project_id: string }>) {
    counts.set(row.project_id, (counts.get(row.project_id) ?? 0) + 1);
  }
  return counts;
}

// ─────────────────────────────────────────────────────────────────────────
// LIST
// ─────────────────────────────────────────────────────────────────────────

export type ListCareerProjectsOptions = {
  query?: string | null;
  limit?: number;
  offset?: number;
};

export async function listCareerProjects(
  options: ListCareerProjectsOptions,
): Promise<ListCareerProjectsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let queryBuilder = supabaseAdmin
    .from("career_projects")
    .select(PROJECT_SELECT, { count: "exact" });

  const rawQuery = options.query?.trim() ?? "";
  if (rawQuery.length > 0) {
    const escaped = escapeForIlike(rawQuery);
    if (escaped.length > 0) {
      const filters = [
        `company_name.ilike.%${escaped}%`,
        `project_name.ilike.%${escaped}%`,
        `job_position.ilike.%${escaped}%`,
        `line_code.ilike.%${escaped}%`,
        `line_name.ilike.%${escaped}%`,
      ];
      if (isUuid(rawQuery)) {
        filters.push(`id.eq.${rawQuery}`);
      }
      queryBuilder = queryBuilder.or(filters.join(","));
    } else if (isUuid(rawQuery)) {
      queryBuilder = queryBuilder.eq("id", rawQuery);
    }
  }

  queryBuilder = queryBuilder
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await queryBuilder;
  if (error) {
    throw new CareerProjectError(500, error.message);
  }

  const rows = (data ?? []) as unknown as CareerProjectRow[];
  const counts = await fetchWeekCounts(rows.map((row) => row.id));
  return {
    rows: rows.map((row) => toDto(row, counts.get(row.id) ?? 0)),
    total: count ?? 0,
    limit,
    offset,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// GET single
// ─────────────────────────────────────────────────────────────────────────

export async function getCareerProject(id: string): Promise<CareerProjectDto> {
  if (!isUuid(id)) {
    throw new CareerProjectError(400, "id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("career_projects")
    .select(PROJECT_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
  if (!data) {
    throw new CareerProjectError(404, "career_project not found");
  }
  const row = data as unknown as CareerProjectRow;
  const counts = await fetchWeekCounts([row.id]);
  return toDto(row, counts.get(row.id) ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────

export async function createCareerProject(
  input: CareerProjectUpsertInput,
): Promise<CareerProjectDto> {
  const payload = buildPayload(input);
  const { data, error } = await supabaseAdmin
    .from("career_projects")
    .insert(payload)
    .select(PROJECT_SELECT)
    .single();
  if (error || !data) {
    throw new CareerProjectError(
      500,
      error?.message ?? "Failed to insert career_project",
    );
  }
  return toDto(data as unknown as CareerProjectRow, 0);
}

// ─────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────

export async function updateCareerProject(
  id: string,
  input: CareerProjectUpsertInput,
): Promise<CareerProjectDto> {
  if (!isUuid(id)) {
    throw new CareerProjectError(400, "id must be a UUID");
  }
  const payload = buildPayload(input);
  const { data, error } = await supabaseAdmin
    .from("career_projects")
    .update(payload)
    .eq("id", id)
    .select(PROJECT_SELECT)
    .maybeSingle();
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
  if (!data) {
    throw new CareerProjectError(404, "career_project not found");
  }
  const row = data as unknown as CareerProjectRow;
  const counts = await fetchWeekCounts([row.id]);
  return toDto(row, counts.get(row.id) ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────
// DELETE — career_records 참조가 있으면 차단(409).
//   career_project_weeks 는 ON DELETE CASCADE 라 정상 정리.
//   career_records 는 FK 가 없을 수 있어 application 레벨에서 사전 검사한다.
// ─────────────────────────────────────────────────────────────────────────

export async function deleteCareerProject(id: string): Promise<void> {
  if (!isUuid(id)) {
    throw new CareerProjectError(400, "id must be a UUID");
  }

  // 1) 존재 확인 — 없는 id 에 대해 노이즈 없이 404.
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("career_projects")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    throw new CareerProjectError(500, existingError.message);
  }
  if (!existing) {
    throw new CareerProjectError(404, "career_project not found");
  }

  // 2) career_records 참조 검사. 테이블이 없거나(42P01) 컬럼 부재면 안전 통과로 간주.
  const { count, error: refError } = await supabaseAdmin
    .from("career_records")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id);
  if (refError && refError.code !== "42P01") {
    throw new CareerProjectError(500, refError.message);
  }
  if ((count ?? 0) > 0) {
    throw new CareerProjectError(
      409,
      `사용 중인 프로젝트는 삭제할 수 없습니다. 연결된 career_records: ${count}건. 먼저 해당 기록을 정리해 주세요.`,
    );
  }

  // 3) 삭제. career_project_weeks 는 CASCADE.
  const { error: delError } = await supabaseAdmin
    .from("career_projects")
    .delete()
    .eq("id", id);
  if (delError) {
    throw new CareerProjectError(500, delError.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PROJECT × WEEK 스케줄링
// ─────────────────────────────────────────────────────────────────────────

type ProjectWeekRow = {
  project_id: string;
  week_id: string;
  is_active: boolean;
  created_at: string | null;
};

async function ensureProjectExists(projectId: string) {
  if (!isUuid(projectId)) {
    throw new CareerProjectError(400, "project id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("career_projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
  if (!data) {
    throw new CareerProjectError(404, "career_project not found");
  }
}

async function ensureWeekExists(weekId: string) {
  if (!isUuid(weekId)) {
    throw new CareerProjectError(400, "week_id must be a UUID");
  }
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("id", weekId)
    .maybeSingle();
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
  if (!data) {
    throw new CareerProjectError(404, "week not found");
  }
}

export async function listCareerProjectWeekStates(
  projectId: string,
): Promise<ListCareerProjectWeeksResult> {
  await ensureProjectExists(projectId);

  const [weeksResult, junctionResult] = await Promise.all([
    supabaseAdmin.from("weeks").select("*"),
    supabaseAdmin
      .from("career_project_weeks")
      .select("project_id,week_id,is_active,created_at")
      .eq("project_id", projectId),
  ]);

  if (weeksResult.error) {
    throw new CareerProjectError(500, weeksResult.error.message);
  }
  if (junctionResult.error) {
    throw new CareerProjectError(500, junctionResult.error.message);
  }

  const weeks = (weeksResult.data ?? []) as Array<Record<string, unknown>>;
  const junctionByWeekId = new Map<string, ProjectWeekRow>();
  for (const row of (junctionResult.data ?? []) as ProjectWeekRow[]) {
    junctionByWeekId.set(row.week_id, row);
  }

  const states: CareerProjectWeekStateDto[] = weeks
    .filter((row): row is Record<string, unknown> & { id: string } =>
      typeof row.id === "string",
    )
    .map((row) => {
      const joined = junctionByWeekId.get(row.id);
      return {
        weekId: row.id,
        attached: Boolean(joined),
        isActive: joined ? Boolean(joined.is_active) : false,
        createdAt: joined?.created_at ?? null,
        weekRow: row,
      };
    });

  return { projectId, states };
}

export async function attachCareerProjectWeek(
  projectId: string,
  weekId: string,
  isActive: boolean,
): Promise<CareerProjectWeekStateDto> {
  await Promise.all([ensureProjectExists(projectId), ensureWeekExists(weekId)]);

  const { data, error } = await supabaseAdmin
    .from("career_project_weeks")
    .upsert(
      {
        project_id: projectId,
        week_id: weekId,
        is_active: isActive,
      },
      { onConflict: "project_id,week_id" },
    )
    .select("project_id,week_id,is_active,created_at")
    .single();
  if (error || !data) {
    throw new CareerProjectError(
      500,
      error?.message ?? "Failed to attach career_project_weeks row",
    );
  }
  const row = data as ProjectWeekRow;

  // weekRow 도 함께 채워서 반환 (UI optimistic update 단순화).
  const { data: weekData, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select("*")
    .eq("id", weekId)
    .maybeSingle();
  if (weekError) {
    throw new CareerProjectError(500, weekError.message);
  }

  return {
    weekId: row.week_id,
    attached: true,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    weekRow: (weekData ?? {}) as Record<string, unknown>,
  };
}

export async function detachCareerProjectWeek(
  projectId: string,
  weekId: string,
): Promise<void> {
  if (!isUuid(projectId)) {
    throw new CareerProjectError(400, "project id must be a UUID");
  }
  if (!isUuid(weekId)) {
    throw new CareerProjectError(400, "week_id must be a UUID");
  }
  const { error } = await supabaseAdmin
    .from("career_project_weeks")
    .delete()
    .eq("project_id", projectId)
    .eq("week_id", weekId);
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
}

export async function setCareerProjectWeekActive(
  projectId: string,
  weekId: string,
  isActive: boolean,
): Promise<CareerProjectWeekStateDto> {
  if (!isUuid(projectId)) {
    throw new CareerProjectError(400, "project id must be a UUID");
  }
  if (!isUuid(weekId)) {
    throw new CareerProjectError(400, "week_id must be a UUID");
  }

  const { data, error } = await supabaseAdmin
    .from("career_project_weeks")
    .update({ is_active: isActive })
    .eq("project_id", projectId)
    .eq("week_id", weekId)
    .select("project_id,week_id,is_active,created_at")
    .maybeSingle();
  if (error) {
    throw new CareerProjectError(500, error.message);
  }
  if (!data) {
    throw new CareerProjectError(
      404,
      "career_project_weeks row not found (attach first)",
    );
  }
  const row = data as ProjectWeekRow;

  const { data: weekData, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select("*")
    .eq("id", weekId)
    .maybeSingle();
  if (weekError) {
    throw new CareerProjectError(500, weekError.message);
  }

  return {
    weekId: row.week_id,
    attached: true,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    weekRow: (weekData ?? {}) as Record<string, unknown>,
  };
}
