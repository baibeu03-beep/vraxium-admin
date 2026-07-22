// Server-only data layer for the line_registrations registry (additive Phase).
//
// 본 모듈은 line_registrations 테이블만 읽고 쓴다 — 기존 4허브 SoT(cluster4_lines ·
// experience/competency 마스터 · career_projects)와 snapshot 경로는 일절 참조하지 않는다.
//
// 유닛 링크 정정 (2026-06-07): 단일 텍스트 unit_link 만 저장/조회한다.
// output_links / output_images 컬럼은 deprecated — SELECT/INSERT 모두 미사용 (값 보존만).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import {
  LINE_REGISTRATION_HUB_LABEL,
  LINE_REGISTRATION_ORG_LABEL,
  EMPTY_UNIT_LINK_SENTINEL,
  type LineDurationMinutes,
  type LineRegistrationCreateInput,
  type LineRegistrationDto,
  type LineRegistrationHub,
  type LineRegistrationMainTitleMode,
  type ListLineRegistrationsResult,
  isLineDurationMinutes,
  isLineRegistrationHub,
  isLineRegistrationOrg,
} from "@/lib/adminLineRegistrationsTypes";
import {
  deriveLineConfigKey,
  loadLinePointLookupAllOrgs,
  type LinePointLookup,
} from "@/lib/adminLinePointConfigsData";

export class LineRegistrationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type RegistrationRow = {
  id: string;
  line_name: string;
  hub: string;
  line_type: string;
  line_code: string;
  main_title_mode: string;
  main_title: string;
  unit_link: string | null;
  organization_slug: string | null;
  bridged_master_id: string | null;
  bridged_at: string | null;
  partner_company: string | null;
  company_logo_url: string | null;
  manager_name: string | null;
  manager_position: string | null;
  manager_job: string | null;
  manager_profile_key: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // info 강화 포인트 연결 키(마이그 전이면 select 에서 제외되어 undefined).
  point_activity_type_id?: string | null;
  // 예상 소요 시간(분) — 30|60|90|120. NULL = 미설정. 마이그 전이면 select 제외 → undefined.
  estimated_duration_minutes?: number | null;
};

const REGISTRATION_SELECT_BASE =
  "id,line_name,hub,line_type,line_code,main_title_mode,main_title,unit_link,organization_slug,bridged_master_id,bridged_at,partner_company,company_logo_url,manager_name,manager_position,manager_job,manager_profile_key,is_active,created_by,created_at,updated_at";

// ── 선택적(마이그레이션 의존) 컬럼 ────────────────────────────────────────────
// 두 컬럼은 서로 다른 마이그레이션에서 왔으므로 상태를 독립적으로 추적한다.
// 미적용(42703)이면 select 에서 빼고 재시도해 목록/상세 조회가 절대 깨지지 않게 한다.
// 한 번 확인하면 프로세스 수명 동안 재사용.
const OPTIONAL_COLUMNS = ["point_activity_type_id", "estimated_duration_minutes"] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
type ColumnState = "unknown" | "present" | "absent";

const optionalColumnState: Record<OptionalColumn, ColumnState> = {
  point_activity_type_id: "unknown",
  estimated_duration_minutes: "unknown",
};

function registrationSelect(): string {
  const cols = [REGISTRATION_SELECT_BASE];
  for (const c of OPTIONAL_COLUMNS) {
    if (optionalColumnState[c] !== "absent") cols.push(c);
  }
  return cols.join(",");
}

// 컬럼 부재 에러(42703/PGRST204) 판정 + 메시지가 지목한 컬럼 추출.
//   PostgREST 는 두 코드 모두 메시지에 컬럼명을 담으므로("column ... does not exist" /
//   "Could not find the 'x' column") 메시지 매칭이 1차 근거다.
//   PGRST205(테이블 미존재)는 폴백 대상이 아니라 진짜 에러이므로 여기서 제외한다.
function columnErrorNames(error: { code?: string; message?: string } | null): {
  isColumnError: boolean;
  named: OptionalColumn[];
} {
  const message = error?.message ?? "";
  const named = OPTIONAL_COLUMNS.filter((c) => message.includes(c));
  const isColumnError =
    error?.code === "42703" || error?.code === "PGRST204" || named.length > 0;
  return { isColumnError, named };
}

// 소요 시간(필수 입력) 컬럼 부재 — 메시지가 이 컬럼을 명시적으로 지목할 때만 참.
//   모호하면 거짓 → 추측으로 "마이그레이션 적용하세요" 오안내를 내보내지 않는다.
function isMissingDurationColumn(error: { code?: string; message?: string } | null): boolean {
  const { isColumnError, named } = columnErrorNames(error);
  return isColumnError && named.includes("estimated_duration_minutes");
}

// point_activity_type_id(선택 입력) 컬럼 부재 — 모호(컬럼명 미특정)해도 참으로 본다.
//   빼고 재시도하면 그만이라 기존의 무회귀 저장 동작을 그대로 유지한다.
function isMissingPointColumn(error: { code?: string; message?: string } | null): boolean {
  const { isColumnError, named } = columnErrorNames(error);
  if (!isColumnError) return false;
  return named.length === 0 || named.includes("point_activity_type_id");
}

// 컬럼 부재면 해당 컬럼을 absent 로 낮춘다(조회 경로 전용).
//   메시지가 컬럼을 특정하면 그 컬럼만, 특정하지 못하면 남은 선택 컬럼 전부를 낮춘다
//   (보수적 폴백 — 조회를 실패시키는 것보다 값을 '-' 로 보여주는 쪽이 안전).
//   반환값 true = 상태를 낮췄으니 재시도할 가치가 있음.
function degradeOptionalColumns(error: { code?: string; message?: string } | null): boolean {
  const { isColumnError, named } = columnErrorNames(error);
  if (!isColumnError) return false;

  const targets: readonly OptionalColumn[] = named.length > 0 ? named : OPTIONAL_COLUMNS;
  let degraded = false;
  for (const c of targets) {
    if (optionalColumnState[c] !== "absent") {
      optionalColumnState[c] = "absent";
      degraded = true;
    }
  }
  return degraded;
}

function markOptionalColumnsPresent(): void {
  for (const c of OPTIONAL_COLUMNS) {
    if (optionalColumnState[c] === "unknown") optionalColumnState[c] = "present";
  }
}

type SupabaseResult<T> = {
  data: T | null;
  error: { code?: string; message?: string } | null;
  count?: number | null;
};

// supabase-js 의 쿼리 빌더는 진짜 Promise 가 아니라 thenable 이라 PromiseLike 로 받는다.
type SupabaseRunner<T> = (selectStr: string) => PromiseLike<SupabaseResult<T>>;

// select 문자열을 받아 쿼리를 실행하고, 컬럼 부재면 낮춰서 재시도한다.
//   선택 컬럼이 2개라 최대 2회까지 낮춰질 수 있으므로 시도 횟수를 여유있게 둔다.
async function runWithColumnFallback<T>(
  run: SupabaseRunner<T>,
): Promise<SupabaseResult<T>> {
  let last: SupabaseResult<T> = await run(registrationSelect());
  for (let attempt = 0; attempt < OPTIONAL_COLUMNS.length; attempt++) {
    if (!last.error) {
      markOptionalColumnsPresent();
      return last;
    }
    if (!degradeOptionalColumns(last.error)) return last;
    last = await run(registrationSelect());
  }
  if (!last.error) markOptionalColumnsPresent();
  return last;
}

// 소요 시간 정규화 — DB CHECK 로 이미 보장되지만, 마이그 전/오염 값이 DTO 타입을 뚫지 않게 막는다.
//   registrations 를 읽는 다른 허브 목록(experience/competency)도 이 함수로 값을 정규화한다.
export function toLineDurationDto(raw: number | null | undefined): LineDurationMinutes | null {
  return isLineDurationMinutes(raw) ? raw : null;
}
const toDurationDto = toLineDurationDto;

// line_registrations 를 "registrations-first" 로 읽는 다른 허브 목록(experience/competency)이
//   소요 시간을 함께 select 할 때 쓰는 헬퍼.
//
//   이 헬퍼가 필요한 이유: 두 목록은 registrations 조회가 실패하면 레거시 마스터로 fallback 한다.
//   마이그 전이라 컬럼이 없다는 이유로 그 fallback 이 발동하면 SoT 가 통째로 바뀌어버린다
//   (2E-6 registrations-first 전환의 회귀). 그래서 컬럼 부재만은 조용히 빼고 재시도해
//   registrations 경로를 유지하고, 값만 null 로 내린다.
export async function selectRegistrationsWithDuration<T>(
  build: SupabaseRunner<T>,
  baseSelect: string,
): Promise<SupabaseResult<T> & { durationAvailable: boolean }> {
  if (optionalColumnState.estimated_duration_minutes !== "absent") {
    const withDuration = await build(`${baseSelect},estimated_duration_minutes`);
    if (!withDuration.error) {
      if (optionalColumnState.estimated_duration_minutes === "unknown") {
        optionalColumnState.estimated_duration_minutes = "present";
      }
      return { ...withDuration, durationAvailable: true };
    }
    // 소요 시간 컬럼 부재가 아니면 진짜 에러 — 호출부의 기존 fallback 판단에 그대로 넘긴다.
    if (!isMissingDurationColumn(withDuration.error)) {
      return { ...withDuration, durationAvailable: true };
    }
    optionalColumnState.estimated_duration_minutes = "absent";
  }
  const without = await build(baseSelect);
  return { ...without, durationAvailable: false };
}

// 라인 → 강화 Point.A/B config 조회값. 오픈확인(weekRecognitionResolve)과 동일 key 도출·동일 SoT.
//   info=point_activity_type_id · experience=line_type→카테고리 · competency=line_code · career=제외.
function resolveLinePoints(
  row: RegistrationRow,
  lookup: LinePointLookup,
): { pointA: number | null; pointB: number | null } {
  const hub: LineRegistrationHub = isLineRegistrationHub(row.hub) ? row.hub : "info";
  const derived = deriveLineConfigKey({
    hub,
    lineType: row.line_type,
    lineCode: row.line_code,
    infoActivityTypeId: row.point_activity_type_id ?? null,
  });
  if (!derived) return { pointA: null, pointB: null };
  return lookup.get(row.organization_slug, derived.hub, derived.configKey);
}

function toDto(
  row: RegistrationRow,
  points: { pointA: number | null; pointB: number | null } = { pointA: null, pointB: null },
): LineRegistrationDto {
  const hub: LineRegistrationHub = isLineRegistrationHub(row.hub) ? row.hub : "info";
  return {
    id: row.id,
    lineName: row.line_name,
    hub,
    hubLabel: LINE_REGISTRATION_HUB_LABEL[hub],
    lineType: row.line_type,
    lineCode: row.line_code,
    mainTitleMode:
      (row.main_title_mode as LineRegistrationMainTitleMode) === "variable"
        ? "variable"
        : "fixed",
    mainTitle: row.main_title,
    unitLink: row.unit_link?.trim() ? row.unit_link : EMPTY_UNIT_LINK_SENTINEL,
    estimatedDurationMinutes: toDurationDto(row.estimated_duration_minutes),
    organizationSlug: isLineRegistrationOrg(row.organization_slug)
      ? row.organization_slug
      : null,
    organizationLabel: isLineRegistrationOrg(row.organization_slug)
      ? LINE_REGISTRATION_ORG_LABEL[row.organization_slug]
      : null,
    pointActivityTypeId: row.point_activity_type_id ?? null,
    pointA: points.pointA,
    pointB: points.pointB,
    bridgedMasterId: row.bridged_master_id,
    bridgedAt: row.bridged_at,
    partnerCompany: row.partner_company,
    companyLogoUrl: row.company_logo_url,
    managerName: row.manager_name,
    managerPosition: row.manager_position,
    managerJob: row.manager_job,
    managerProfileKey: row.manager_profile_key,
    isActive: row.is_active,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type ListLineRegistrationsOptions = {
  hub?: LineRegistrationHub | null;
  // 조직 스코프(통합 ↔ 조직). null/미지정 = 통합(전체). 지정 시 organization_slug ∈ {org, "common"}.
  // 고객 가시성 정책과 동일하게 공통(common)은 모든 조직 화면에 노출한다.
  organization?: OrganizationSlug | null;
  limit?: number;
  offset?: number;
};

export async function listLineRegistrations(
  options: ListLineRegistrationsOptions = {},
): Promise<ListLineRegistrationsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const run = async (selectStr: string) => {
    let query = supabaseAdmin
      .from("line_registrations")
      .select(selectStr, { count: "exact" });
    if (options.hub) {
      query = query.eq("hub", options.hub);
    }
    if (options.organization) {
      // 조직 화면 = 해당 조직 + 공통(common). count:"exact" 가 실제 필터 기준이라 페이지네이션 정확.
      query = query.in("organization_slug", [options.organization, "common"]);
    }
    query = query
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    return query;
  };

  // 마이그 전(선택 컬럼 부재) → 해당 컬럼을 빼고 폴백(목록 무회귀 · 값은 DTO 에서 null).
  const { data, error, count } = await runWithColumnFallback(run);
  if (error) {
    // Postgres/PostgREST 원문(테이블·컬럼명)은 클라이언트로 내보내지 않는다(로그 전용).
    console.error("[listLineRegistrations] load failed", error);
    throw new LineRegistrationError(500, "라인 목록을 불러오지 못했습니다");
  }

  // 강화 Point.A/B 조회(오픈확인과 동일 SoT·규칙). 테이블 미적용이면 전부 null.
  const lookup = await loadLinePointLookupAllOrgs();
  return {
    rows: ((data ?? []) as unknown as RegistrationRow[]).map((r) =>
      toDto(r, resolveLinePoints(r, lookup)),
    ),
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function getLineRegistration(id: string): Promise<LineRegistrationDto> {
  const run = (selectStr: string) =>
    supabaseAdmin
      .from("line_registrations")
      .select(selectStr)
      .eq("id", id)
      .maybeSingle();

  const { data, error } = await runWithColumnFallback(run);
  if (error) {
    // Postgres/PostgREST 원문(테이블·컬럼·제약 이름)은 클라이언트로 내보내지 않는다.
    console.error("[getLineRegistration] load failed", error);
    throw new LineRegistrationError(500, "라인 정보를 불러오지 못했습니다");
  }
  if (!data) {
    throw new LineRegistrationError(404, "등록된 라인을 찾을 수 없습니다");
  }
  const row = data as unknown as RegistrationRow;
  const lookup = await loadLinePointLookupAllOrgs();
  return toDto(row, resolveLinePoints(row, lookup));
}

export async function createLineRegistration(
  input: LineRegistrationCreateInput,
  actorAdminId: string,
): Promise<LineRegistrationDto> {
  const basePayload = {
    line_name: input.lineName,
    hub: input.hub,
    line_type: input.lineType,
    line_code: input.lineCode,
    main_title_mode: input.mainTitleMode,
    main_title: input.mainTitle,
    unit_link: input.unitLink,
    organization_slug: input.organizationSlug,
    partner_company: input.partnerCompany,
    company_logo_url: input.companyLogoUrl,
    manager_name: input.managerName,
    manager_position: input.managerPosition,
    manager_job: input.managerJob,
    manager_profile_key: input.managerProfileKey,
    created_by: actorAdminId,
    // 소요 시간은 신규 등록 필수 — point_activity_type_id 와 달리 컬럼 부재 시 조용히 빼지 않는다
    //   (필수 입력값을 소리 없이 버리면 사용자는 저장됐다고 믿는다). 아래에서 명시적으로 실패시킨다.
    estimated_duration_minutes: input.estimatedDurationMinutes,
  };

  const insert = (payload: Record<string, unknown>, selectStr: string) =>
    supabaseAdmin.from("line_registrations").insert(payload).select(selectStr).single();

  const withPoint = optionalColumnState.point_activity_type_id !== "absent";
  const payload = withPoint
    ? { ...basePayload, point_activity_type_id: input.pointActivityTypeId ?? null }
    : basePayload;

  let { data, error } = await insert(payload, registrationSelect());

  // 소요 시간 컬럼 미적용 → 필수값을 버리고 성공시키지 않는다. 마이그레이션 안내로 즉시 실패.
  if (error && isMissingDurationColumn(error)) {
    optionalColumnState.estimated_duration_minutes = "absent";
    throw new LineRegistrationError(
      500,
      // 상세(컬럼/마이그레이션 파일)는 서버 로그에만 — 사용자에게는 조치 불가한 내부 정보다.
      "라인 정보 저장 준비가 완료되지 않았습니다. 관리자에게 문의해주세요.",
    );
  }
  // point 컬럼 미적용 → 컬럼 제거 후 재시도(선택 입력이라 기존처럼 무회귀 저장).
  if (error && withPoint && isMissingPointColumn(error)) {
    optionalColumnState.point_activity_type_id = "absent";
    ({ data, error } = await insert(basePayload, registrationSelect()));
  }
  if (!error) markOptionalColumnsPresent();

  if (error || !data) {
    // 23514 = CHECK 위반. 파서가 이미 막지만 DB 가 최종 게이트 — 값 도메인 위반을 400 으로 되돌린다.
    if (error?.code === "23514" && /estimated_duration_minutes/.test(error.message ?? "")) {
      throw new LineRegistrationError(
        400,
        "소요 시간은 30, 60, 90, 120분 중에서 선택해주세요.",
      );
    }
    // PGRST205 = 테이블 미존재 — 마이그레이션 미적용 안내를 명확히 한다.
    const code = error?.code;
    if (code === "PGRST205" || code === "PGRST204") {
      throw new LineRegistrationError(
        500,
        "라인 정보 저장 준비가 완료되지 않았습니다. 관리자에게 문의해주세요.",
      );
    }
    // 23505 = unique 위반. uq_line_registrations_hub_org_code (hub, organization_slug, line_code)
    //   → 사용자가 고칠 수 있는 업무 충돌이므로 409 + 업무 문구. Postgres 원문은 로그로만 남긴다.
    if (error?.code === "23505") {
      console.error("[createLineRegistration] unique violation", error);
      throw new LineRegistrationError(
        409,
        `이미 등록된 라인 코드입니다 (${input.lineCode}). 같은 허브·클럽에 중복 등록할 수 없습니다.`,
      );
    }
    // 그 외 DB 오류 — 원문(테이블/컬럼/제약 이름)을 클라이언트로 내보내지 않는다(로그 전용).
    console.error("[createLineRegistration] insert failed", error);
    throw new LineRegistrationError(500, "라인 등록에 실패했습니다");
  }
  const row = data as unknown as RegistrationRow;
  const lookup = await loadLinePointLookupAllOrgs();
  return toDto(row, resolveLinePoints(row, lookup));
}

// ─────────────────────────────────────────────────────────────────────────
// 관리 기능 (2E-6 선행) — 상세 + 부분 수정. DELETE 미제공(soft 비활성만).
// ─────────────────────────────────────────────────────────────────────────

// bridged_master_id 를 참조하는 개설 라인 수 — 게이트 필드(line_code/org/exp 종류) 잠금 판정.
async function countOpenedLines(
  hub: LineRegistrationHub,
  bridgedMasterId: string | null,
): Promise<number> {
  if (!bridgedMasterId) return 0;
  const fkColumn =
    hub === "experience"
      ? "experience_line_master_id"
      : hub === "competency"
        ? "competency_line_master_id"
        : hub === "career"
          ? "career_project_id"
          : null;
  if (!fkColumn) return 0; // info — 마스터 FK 없음
  const { count, error } = await supabaseAdmin
    .from("cluster4_lines")
    .select("*", { count: "exact", head: true })
    .eq(fkColumn, bridgedMasterId);
  if (error) {
    // 게이트 판정 실패는 보수적으로 "개설 있음" 취급 (잠금) — 운영 안전 우선.
    console.warn("[line-registrations] openedLineCount 조회 실패 — 게이트 잠금", {
      bridgedMasterId,
      message: error.message,
    });
    return Number.MAX_SAFE_INTEGER;
  }
  return count ?? 0;
}

export type LineRegistrationDetail = LineRegistrationDto & {
  // 이 등록의 mirror 마스터를 참조하는 개설 라인 수 — 0 이 아니면 게이트 필드 수정 불가.
  openedLineCount: number;
};

export async function getLineRegistrationDetail(
  id: string,
): Promise<LineRegistrationDetail> {
  const dto = await getLineRegistration(id);
  const openedLineCount = await countOpenedLines(dto.hub, dto.bridgedMasterId);
  return { ...dto, openedLineCount };
}

import type { LineRegistrationPatchInput } from "@/lib/adminLineRegistrationsTypes";
import {
  LINE_REGISTRATION_LINE_TYPES,
  LINE_REGISTRATION_HUB_LABEL as HUB_LABEL_FOR_PATCH,
} from "@/lib/adminLineRegistrationsTypes";
import { syncMasterFromRegistration } from "@/lib/lineMasterDriftGuard";

export type LineRegistrationUpdateResult = {
  registration: LineRegistrationDetail;
  driftSync: { synced: boolean; warning: string | null };
};

// 부분 수정 — 설계(2026-06-07) 게이트/검증을 데이터 레이어에서 강제한다.
//   - hub 변경 불가(파서에서 거부) · bridged_* 시스템 필드.
//   - line_code / organization_slug / (hub=experience 의) line_type: openedLineCount=0 일 때만.
//   - bridged 행에서 organization_slug → null 복귀 금지(마스터 org NOT NULL).
//   - career 전용 필드는 hub=career 행에서만.
//   - (hub, org, code) partial unique 사전 검사(자기 자신 제외).
//   - 성공 시 bridged 행이면 mirror 마스터로 정방향 sync (registration = 입력 SoT).
export async function updateLineRegistration(
  id: string,
  patch: LineRegistrationPatchInput,
): Promise<LineRegistrationUpdateResult> {
  const current = await getLineRegistrationDetail(id);

  // ── hub 의존 검증 ──
  if (patch.lineType !== undefined) {
    if (!LINE_REGISTRATION_LINE_TYPES[current.hub].includes(patch.lineType)) {
      throw new LineRegistrationError(
        400,
        `'${patch.lineType}'은(는) ${HUB_LABEL_FOR_PATCH[current.hub]} 허브에서 선택할 수 없는 라인 종류입니다.`,
      );
    }
  }
  const careerFieldTouched =
    patch.partnerCompany !== undefined ||
    patch.companyLogoUrl !== undefined ||
    patch.managerName !== undefined ||
    patch.managerPosition !== undefined ||
    patch.managerJob !== undefined ||
    patch.managerProfileKey !== undefined;
  if (careerFieldTouched && current.hub !== "career") {
    throw new LineRegistrationError(
      400,
      "실무 경력 전용 항목은 실무 경력 라인에서만 수정할 수 있습니다.",
    );
  }

  // ── 개설 라인 게이트 ──
  const gateTouched =
    (patch.lineCode !== undefined && patch.lineCode !== current.lineCode) ||
    (patch.organizationSlug !== undefined && patch.organizationSlug !== current.organizationSlug) ||
    (current.hub === "experience" &&
      patch.lineType !== undefined &&
      patch.lineType !== current.lineType);
  if (gateTouched && current.openedLineCount > 0) {
    throw new LineRegistrationError(
      409,
      `이미 개설된 라인이 ${current.openedLineCount}건 있어 라인 코드·소속 클럽·라인 종류는 수정할 수 없습니다. 이 라인을 비활성화한 뒤 새로 등록해주세요.`,
    );
  }

  // ── org null 복귀 금지 (bridged 행 — 마스터 org NOT NULL) ──
  if (
    patch.organizationSlug === null &&
    current.bridgedMasterId !== null
  ) {
    throw new LineRegistrationError(
      400,
      "개설 연결된 등록은 소속 클럽을 미지정(-)으로 되돌릴 수 없습니다",
    );
  }

  // ── main_title 모드 정합 ──
  if (patch.mainTitle !== undefined && patch.mainTitleMode === undefined) {
    if (current.mainTitleMode === "variable") {
      throw new LineRegistrationError(
        400,
        "메인 타이틀 표시 방식이 '변동'이면 메인 타이틀을 직접 수정할 수 없습니다. '고정'으로 함께 바꿔주세요.",
      );
    }
  }

  // ── (hub, org, code) unique 사전 검사 (자기 자신 제외) ──
  const nextOrg =
    patch.organizationSlug !== undefined ? patch.organizationSlug : current.organizationSlug;
  const nextCode = patch.lineCode ?? current.lineCode;
  if (nextOrg !== null && (nextCode !== current.lineCode || nextOrg !== current.organizationSlug)) {
    const { data: dup } = await supabaseAdmin
      .from("line_registrations")
      .select("id")
      .eq("hub", current.hub)
      .eq("organization_slug", nextOrg)
      .eq("line_code", nextCode)
      .neq("id", id)
      .maybeSingle();
    if (dup) {
      throw new LineRegistrationError(
        409,
        `이미 등록된 라인 코드입니다 (${nextCode}). 같은 허브·클럽에 중복 등록할 수 없습니다.`,
      );
    }
  }

  // ── update payload (snake_case) ──
  const payload: Record<string, unknown> = {};
  if (patch.lineName !== undefined) payload.line_name = patch.lineName;
  if (patch.lineCode !== undefined) payload.line_code = patch.lineCode;
  if (patch.lineType !== undefined) payload.line_type = patch.lineType;
  if (patch.mainTitleMode !== undefined) payload.main_title_mode = patch.mainTitleMode;
  if (patch.mainTitle !== undefined) payload.main_title = patch.mainTitle;
  if (patch.unitLink !== undefined) payload.unit_link = patch.unitLink;
  // 소요 시간 — 허브/개설 게이트와 무관하게 언제나 수정 가능(마스터 메타 · 개설 결과에 영향 없음).
  //   레거시 NULL 행을 값 있는 상태로 올리는 유일한 경로다.
  if (patch.estimatedDurationMinutes !== undefined) {
    payload.estimated_duration_minutes = patch.estimatedDurationMinutes;
  }
  if (patch.organizationSlug !== undefined) payload.organization_slug = patch.organizationSlug;
  if (patch.partnerCompany !== undefined) payload.partner_company = patch.partnerCompany;
  if (patch.companyLogoUrl !== undefined) payload.company_logo_url = patch.companyLogoUrl;
  if (patch.managerName !== undefined) payload.manager_name = patch.managerName;
  if (patch.managerPosition !== undefined) payload.manager_position = patch.managerPosition;
  if (patch.managerJob !== undefined) payload.manager_job = patch.managerJob;
  if (patch.managerProfileKey !== undefined) payload.manager_profile_key = patch.managerProfileKey;
  if (patch.isActive !== undefined) payload.is_active = patch.isActive;
  // info 강화 포인트 연결 키 — info 행 & 컬럼 적용된 경우에만 반영(비-info/미적용은 조용히 무시).
  //   (current 조회가 위에서 이미 pointActivityColumn 을 present/absent 로 확정한다.)
  if (
    patch.pointActivityTypeId !== undefined &&
    current.hub === "info" &&
    optionalColumnState.point_activity_type_id === "present"
  ) {
    payload.point_activity_type_id = patch.pointActivityTypeId;
  }

  if (Object.keys(payload).length === 0) {
    // 게이트/무시 후 실제 반영 컬럼이 없으면 update skip(패치는 성공 처리) — 현재값 반환.
    const unchanged = await getLineRegistrationDetail(id);
    const sync = await syncMasterFromRegistration(unchanged);
    return { registration: unchanged, driftSync: { synced: sync.synced, warning: sync.warning } };
  }

  const { error: updateError } = await supabaseAdmin
    .from("line_registrations")
    .update(payload)
    .eq("id", id);
  if (updateError) {
    // 소요 시간은 등록과 동일하게 조용히 버리지 않는다 — 사용자가 고른 값이 사라지면 안 된다.
    if (isMissingDurationColumn(updateError)) {
      optionalColumnState.estimated_duration_minutes = "absent";
      throw new LineRegistrationError(
        500,
        // 상세(컬럼/마이그레이션 파일)는 서버 로그에만 — 사용자에게는 조치 불가한 내부 정보다.
      "라인 정보 저장 준비가 완료되지 않았습니다. 관리자에게 문의해주세요.",
      );
    }
    if (
      updateError.code === "23514" &&
      /estimated_duration_minutes/.test(updateError.message ?? "")
    ) {
      throw new LineRegistrationError(
        400,
        "소요 시간은 30, 60, 90, 120분 중에서 선택해주세요.",
      );
    }
    // Postgres 원문(제약/컬럼명) 노출 금지 — 상세는 서버 로그로만.
    console.error("[updateLineRegistration] update failed", updateError);
    throw new LineRegistrationError(500, "라인 수정에 실패했습니다");
  }

  // ── mirror 정방향 sync (registration = 입력 SoT) ──
  const updated = await getLineRegistrationDetail(id);
  const sync = await syncMasterFromRegistration(updated);

  return { registration: updated, driftSync: { synced: sync.synced, warning: sync.warning } };
}
