// Server-only data layer for the line_registrations registry (additive Phase).
//
// 본 모듈은 line_registrations 테이블만 읽고 쓴다 — 기존 4허브 SoT(cluster4_lines ·
// experience/competency 마스터 · career_projects)와 snapshot 경로는 일절 참조하지 않는다.
//
// 유닛 링크 정정 (2026-06-07): 단일 텍스트 unit_link 만 저장/조회한다.
// output_links / output_images 컬럼은 deprecated — SELECT/INSERT 모두 미사용 (값 보존만).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  LINE_REGISTRATION_HUB_LABEL,
  LINE_REGISTRATION_ORG_LABEL,
  EMPTY_UNIT_LINK_SENTINEL,
  type LineRegistrationCreateInput,
  type LineRegistrationDto,
  type LineRegistrationHub,
  type LineRegistrationMainTitleMode,
  type ListLineRegistrationsResult,
  isLineRegistrationHub,
  isLineRegistrationOrg,
} from "@/lib/adminLineRegistrationsTypes";

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
};

const REGISTRATION_SELECT =
  "id,line_name,hub,line_type,line_code,main_title_mode,main_title,unit_link,organization_slug,bridged_master_id,bridged_at,partner_company,company_logo_url,manager_name,manager_position,manager_job,manager_profile_key,is_active,created_by,created_at,updated_at";

function toDto(row: RegistrationRow): LineRegistrationDto {
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
    organizationSlug: isLineRegistrationOrg(row.organization_slug)
      ? row.organization_slug
      : null,
    organizationLabel: isLineRegistrationOrg(row.organization_slug)
      ? LINE_REGISTRATION_ORG_LABEL[row.organization_slug]
      : null,
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
  limit?: number;
  offset?: number;
};

export async function listLineRegistrations(
  options: ListLineRegistrationsOptions = {},
): Promise<ListLineRegistrationsResult> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  let query = supabaseAdmin
    .from("line_registrations")
    .select(REGISTRATION_SELECT, { count: "exact" });
  if (options.hub) {
    query = query.eq("hub", options.hub);
  }
  query = query
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) {
    throw new LineRegistrationError(500, error.message);
  }
  return {
    rows: ((data ?? []) as unknown as RegistrationRow[]).map(toDto),
    total: count ?? 0,
    limit,
    offset,
  };
}

export async function getLineRegistration(id: string): Promise<LineRegistrationDto> {
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select(REGISTRATION_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new LineRegistrationError(500, error.message);
  }
  if (!data) {
    throw new LineRegistrationError(404, "line registration not found");
  }
  return toDto(data as unknown as RegistrationRow);
}

export async function createLineRegistration(
  input: LineRegistrationCreateInput,
  actorAdminId: string,
): Promise<LineRegistrationDto> {
  const payload = {
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
  };

  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .insert(payload)
    .select(REGISTRATION_SELECT)
    .single();
  if (error || !data) {
    // PGRST205/204 = 테이블·컬럼 미존재 — 마이그레이션 미적용 안내를 명확히 한다.
    const code = (error as { code?: string } | null)?.code;
    if (code === "PGRST205" || code === "PGRST204") {
      throw new LineRegistrationError(
        500,
        "line_registrations 스키마가 최신이 아닙니다. db/migrations/2026-06-07_line_registrations.sql · _unit_link.sql 을 SQL Editor 에서 적용해주세요.",
      );
    }
    throw new LineRegistrationError(
      500,
      error?.message ?? "Failed to create line registration",
    );
  }
  return toDto(data as unknown as RegistrationRow);
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
        `line_type '${patch.lineType}' 은(는) ${HUB_LABEL_FOR_PATCH[current.hub]} 허브에서 선택할 수 없습니다`,
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
    throw new LineRegistrationError(400, "실무 경력 전용 필드는 career 행에서만 수정할 수 있습니다");
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
      `이미 개설된 라인이 ${current.openedLineCount}건 있어 라인 코드/소속 조직/경험 라인 종류는 수정할 수 없습니다 (비활성화 후 신규 등록을 사용하세요)`,
    );
  }

  // ── org null 복귀 금지 (bridged 행 — 마스터 org NOT NULL) ──
  if (
    patch.organizationSlug === null &&
    current.bridgedMasterId !== null
  ) {
    throw new LineRegistrationError(
      400,
      "개설 연결된 등록은 소속 조직을 미지정(-)으로 되돌릴 수 없습니다",
    );
  }

  // ── main_title 모드 정합 ──
  if (patch.mainTitle !== undefined && patch.mainTitleMode === undefined) {
    if (current.mainTitleMode === "variable") {
      throw new LineRegistrationError(
        400,
        "변동(variable) 모드에서는 main_title 을 직접 수정할 수 없습니다 — main_title_mode=fixed 로 함께 전환하세요",
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
        `동일 허브/조직에 같은 라인 코드(${nextCode})의 등록이 이미 있습니다`,
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
  if (patch.organizationSlug !== undefined) payload.organization_slug = patch.organizationSlug;
  if (patch.partnerCompany !== undefined) payload.partner_company = patch.partnerCompany;
  if (patch.companyLogoUrl !== undefined) payload.company_logo_url = patch.companyLogoUrl;
  if (patch.managerName !== undefined) payload.manager_name = patch.managerName;
  if (patch.managerPosition !== undefined) payload.manager_position = patch.managerPosition;
  if (patch.managerJob !== undefined) payload.manager_job = patch.managerJob;
  if (patch.managerProfileKey !== undefined) payload.manager_profile_key = patch.managerProfileKey;
  if (patch.isActive !== undefined) payload.is_active = patch.isActive;

  const { error: updateError } = await supabaseAdmin
    .from("line_registrations")
    .update(payload)
    .eq("id", id);
  if (updateError) {
    throw new LineRegistrationError(500, updateError.message);
  }

  // ── mirror 정방향 sync (registration = 입력 SoT) ──
  const updated = await getLineRegistrationDetail(id);
  const sync = await syncMasterFromRegistration(updated);

  return { registration: updated, driftSync: { synced: sync.synced, warning: sync.warning } };
}
