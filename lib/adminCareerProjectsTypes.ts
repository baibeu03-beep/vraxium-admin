// Browser-safe constants and types for the /admin/career-projects view.
// Must not import server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.
//
// canonical schema: db/migrations/2026-05-22_cluster4_card_base_step2_career_projects.sql
//                   db/migrations/2026-05-22_cluster4_card_base_step3_career_project_weeks.sql
//                   db/migrations/2026-05-22_career_projects_admin_meta.sql (updated_at)

export type CareerProjectDto = {
  id: string;

  // 회사 / 직무 메타
  companyName: string | null;
  companyLogoUrl: string | null;
  jobPosition: string | null;

  // 프로젝트 메타
  projectName: string | null;
  projectDescription: string | null;
  lineCode: string | null;
  lineName: string | null;

  // Career-Resume Front secondary info (admin 1차 UX 는 JSON 텍스트 입력)
  outputLinks: unknown;
  outputImages: unknown;
  companyHomepageLinks: unknown;
  secondaryInfoDeadline: string | null;

  // supervisor 정보
  supervisorName: string | null;
  supervisorPosition: string | null;
  supervisorDepartment: string | null;
  supervisorCompany: string | null;
  supervisorProfileImg: string | null;

  // career line defaults (MVP 확장)
  startDate: string | null;
  endDate: string | null;
  defaultMainTitle: string | null;
  defaultOutputLink1: string | null;
  defaultOutputLink2: string | null;
  defaultOutputImages: string[];
  defaultTargetUserIds: string[];
  organizationSlug: string;

  createdAt: string;
  updatedAt: string | null;

  // 운영 보조 — 목록 화면에서 연결된 주차 수를 보여주기 위함
  weekCount: number;
};

export type ListCareerProjectsResult = {
  rows: CareerProjectDto[];
  total: number;
  limit: number;
  offset: number;
};

export type CareerProjectUpsertInput = {
  companyName: string | null;
  companyLogoUrl: string | null;
  jobPosition: string | null;

  projectName: string | null;
  projectDescription: string | null;
  lineCode: string | null;
  lineName: string | null;

  outputLinks: unknown;
  outputImages: unknown;
  companyHomepageLinks: unknown;
  secondaryInfoDeadline: string | null;

  supervisorName: string | null;
  supervisorPosition: string | null;
  supervisorDepartment: string | null;
  supervisorCompany: string | null;
  supervisorProfileImg: string | null;

  startDate: string | null;
  endDate: string | null;
  defaultMainTitle: string | null;
  defaultOutputLink1: string | null;
  defaultOutputLink2: string | null;
  defaultOutputImages: string[];
  defaultTargetUserIds: string[];
  organizationSlug: string | null;
};

// 주차 연결 상태 — 한 프로젝트가 어떤 주차들에 attach 되어 있고 각 상태가 무엇인지.
// "프로젝트 입장에서" 전체 weeks 카탈로그 위에 attach/active 플래그를 얹어 보여준다.
export type CareerProjectWeekStateDto = {
  weekId: string;
  attached: boolean;     // career_project_weeks row 존재 여부
  isActive: boolean;     // attached=true 일 때만 의미 있음
  createdAt: string | null;
  // weeks 테이블 row 의 운영용 식별값 — 컬럼 이름은 환경마다 다를 수 있어
  // 그대로 패스스루. 클라이언트가 자유롭게 라벨링한다.
  weekRow: Record<string, unknown>;
};

export type ListCareerProjectWeeksResult = {
  projectId: string;
  states: CareerProjectWeekStateDto[];
};

// PATCH body — 단일 (project, week) pair 에 대한 액션.
export type CareerProjectWeekAction =
  | { action: "attach"; week_id: string; is_active?: boolean }
  | { action: "detach"; week_id: string }
  | { action: "set_active"; week_id: string; is_active: boolean };

export function isCareerProjectWeekAction(
  value: unknown,
): value is CareerProjectWeekAction {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.week_id !== "string" || v.week_id.length === 0) return false;
  if (v.action === "attach") {
    return v.is_active === undefined || typeof v.is_active === "boolean";
  }
  if (v.action === "detach") {
    return true;
  }
  if (v.action === "set_active") {
    return typeof v.is_active === "boolean";
  }
  return false;
}

// jsonb 컬럼은 1차 UX 에서 JSON 텍스트로 받는다. 빈 문자열은 빈 배열로 정규화한다.
// admin 이 잘못된 JSON 을 넣으면 그대로 reject — 400 으로 친절히 안내한다.
export type ParsedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function parseJsonField(
  raw: unknown,
  fieldName: string,
): ParsedJsonResult {
  if (raw === undefined || raw === null) {
    return { ok: true, value: [] };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: true, value: [] };
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (error) {
      return {
        ok: false,
        error: `${fieldName} must be valid JSON: ${
          error instanceof Error ? error.message : "parse error"
        }`,
      };
    }
  }
  // 이미 파싱된 jsonb (객체/배열) 도 그대로 수용 — API 호출 측 편의.
  if (typeof raw === "object") {
    return { ok: true, value: raw };
  }
  return { ok: false, error: `${fieldName} must be JSON, string, or null` };
}

// 클라이언트가 jsonb 값을 textarea 에 표시할 때 쓰는 직렬화 — 항상 2-space indent.
export function stringifyJsonField(value: unknown): string {
  if (value === null || value === undefined) return "[]";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[]";
  }
}

// admin_users.role === "owner" 만 쓰기 가능. read role 은 admin/viewer 까지.
// (matrix(role_permissions) 와 무관 — admin_users.role 직접 게이트)
export const CAREER_PROJECTS_WRITE_ROLES = ["owner"] as const;

// HTTP body(snake_case JSON) → CareerProjectUpsertInput(camelCase) 정규화.
// 양쪽 API 라우트(POST /career-projects, PATCH /career-projects/[id]) 에서 공유.
export type ParseUpsertBodyResult =
  | { ok: true; value: CareerProjectUpsertInput }
  | { ok: false; status: number; error: string };

const TEXT_KEYS = [
  "company_name",
  "company_logo_url",
  "job_position",
  "project_name",
  "project_description",
  "line_code",
  "line_name",
  "supervisor_name",
  "supervisor_position",
  "supervisor_department",
  "supervisor_company",
  "supervisor_profile_img",
  "start_date",
  "end_date",
  "default_main_title",
  "default_output_link_1",
  "default_output_link_2",
  "organization_slug",
] as const;

type TextKey = (typeof TEXT_KEYS)[number];

function normalizeTextField(
  raw: unknown,
  key: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${key} must be a string or null` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length ? trimmed : null };
}

export function parseCareerProjectUpsertBody(
  body: unknown,
): ParseUpsertBodyResult {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const input = body as Record<string, unknown>;

  const texts: Partial<Record<TextKey, string | null>> = {};
  for (const key of TEXT_KEYS) {
    const result = normalizeTextField(input[key], key);
    if (!result.ok) return { ok: false, status: 400, error: result.error };
    texts[key] = result.value;
  }

  const outputLinks = parseJsonField(input.output_links, "output_links");
  if (!outputLinks.ok) return { ok: false, status: 400, error: outputLinks.error };
  const outputImages = parseJsonField(input.output_images, "output_images");
  if (!outputImages.ok) return { ok: false, status: 400, error: outputImages.error };
  const companyHomepageLinks = parseJsonField(
    input.company_homepage_links,
    "company_homepage_links",
  );
  if (!companyHomepageLinks.ok) {
    return { ok: false, status: 400, error: companyHomepageLinks.error };
  }

  let secondaryInfoDeadline: string | null = null;
  if (
    input.secondary_info_deadline !== undefined &&
    input.secondary_info_deadline !== null
  ) {
    if (typeof input.secondary_info_deadline !== "string") {
      return {
        ok: false,
        status: 400,
        error: "secondary_info_deadline must be ISO string or null",
      };
    }
    const trimmed = input.secondary_info_deadline.trim();
    secondaryInfoDeadline = trimmed.length ? trimmed : null;
  }

  // default_output_images — jsonb array of URLs
  const defaultOutputImages = parseJsonField(
    input.default_output_images,
    "default_output_images",
  );
  if (!defaultOutputImages.ok) {
    return { ok: false, status: 400, error: defaultOutputImages.error };
  }
  const defaultImgs = Array.isArray(defaultOutputImages.value)
    ? (defaultOutputImages.value as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      )
    : [];

  // default_target_user_ids — jsonb array of UUIDs
  let defaultTargetUserIds: string[] = [];
  if (input.default_target_user_ids !== undefined && input.default_target_user_ids !== null) {
    if (!Array.isArray(input.default_target_user_ids)) {
      return { ok: false, status: 400, error: "default_target_user_ids must be an array" };
    }
    for (const uid of input.default_target_user_ids) {
      if (typeof uid !== "string" || uid.trim().length === 0) {
        return { ok: false, status: 400, error: "default_target_user_ids items must be non-empty strings" };
      }
      defaultTargetUserIds.push(uid.trim());
    }
  }

  return {
    ok: true,
    value: {
      companyName: texts.company_name ?? null,
      companyLogoUrl: texts.company_logo_url ?? null,
      jobPosition: texts.job_position ?? null,
      projectName: texts.project_name ?? null,
      projectDescription: texts.project_description ?? null,
      lineCode: texts.line_code ?? null,
      lineName: texts.line_name ?? null,
      outputLinks: outputLinks.value,
      outputImages: outputImages.value,
      companyHomepageLinks: companyHomepageLinks.value,
      secondaryInfoDeadline,
      supervisorName: texts.supervisor_name ?? null,
      supervisorPosition: texts.supervisor_position ?? null,
      supervisorDepartment: texts.supervisor_department ?? null,
      supervisorCompany: texts.supervisor_company ?? null,
      supervisorProfileImg: texts.supervisor_profile_img ?? null,
      startDate: texts.start_date ?? null,
      endDate: texts.end_date ?? null,
      defaultMainTitle: texts.default_main_title ?? null,
      defaultOutputLink1: texts.default_output_link_1 ?? null,
      defaultOutputLink2: texts.default_output_link_2 ?? null,
      defaultOutputImages: defaultImgs,
      defaultTargetUserIds: defaultTargetUserIds,
      organizationSlug: texts.organization_slug ?? null,
    },
  };
}
