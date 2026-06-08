// Server-only — Phase 2C 브리지: line_registrations → 허브별 마스터 find-or-create.
//
// 계약 (2026-06-07 결정):
//   - 기존 마스터를 찾으면 **절대 덮어쓰지 않고** 연결만 한다 (필드 무수정).
//   - 마스터가 없을 때만 registrations 값으로 생성한다.
//   - cluster4_lines/snapshot/개설 플로우 코드는 호출하지도 수정하지도 않는다 —
//     브리지는 마스터 행 확보 + line_registrations.bridged_* 기록까지만.
//     개설은 기존 허브별 플로우(마스터 드롭다운)에서 그대로 수행된다.
//   - info: 마스터가 없으므로 브리지 불가(프리필 전용 — UI 안내).
//   - org 미지정(null) 등록은 브리지 불가 (마스터 UNIQUE(org, line_code) 정합 + 분모A org 판정).
//   - career 프로필: manager_profile_key 토큰은 supervisor_profile_img 로 옮기지 않는다(NULL) —
//     이미지 자산 확정 후 별도 작업 (2026-06-07 결정 4).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { LineRegistrationDto } from "@/lib/adminLineRegistrationsTypes";
import {
  LineRegistrationError,
  getLineRegistration,
} from "@/lib/adminLineRegistrationsData";

export class LineBridgeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 라인 종류(한글) → experience_category/slot — 마스터 CHECK 고정쌍과 동일
// (cluster4_exp_masters_cat_slot_pair_chk: derivation1/analysis2/evaluation3/extension4/management5).
const EXPERIENCE_TYPE_TO_CATEGORY: Record<string, { category: string; slot: number }> = {
  도출: { category: "derivation", slot: 1 },
  분석: { category: "analysis", slot: 2 },
  평가: { category: "evaluation", slot: 3 },
  확장: { category: "extension", slot: 4 },
  관리: { category: "management", slot: 5 },
};

export type LineBridgeResult = {
  registrationId: string;
  hub: LineRegistrationDto["hub"];
  // found = 기존 마스터에 연결만(무수정) / created = 신규 생성 / already_bridged = 이전 브리지 재사용.
  action: "found" | "created" | "already_bridged";
  masterTable:
    | "cluster4_experience_line_masters"
    | "cluster4_competency_line_masters"
    | "career_projects";
  masterId: string;
  bridgedAt: string;
};

function fixedTitleOrNull(reg: LineRegistrationDto): string | null {
  return reg.mainTitleMode === "fixed" ? reg.mainTitle : null;
}

async function findOrCreateExperienceMaster(reg: LineRegistrationDto) {
  const { data: found, error: findError } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("organization_slug", reg.organizationSlug!)
    .eq("line_code", reg.lineCode)
    .maybeSingle();
  if (findError) throw new LineBridgeError(500, findError.message);
  if (found) return { id: (found as { id: string }).id, action: "found" as const };

  const pair = EXPERIENCE_TYPE_TO_CATEGORY[reg.lineType] ?? null;
  const { data: created, error: createError } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .insert({
      line_code: reg.lineCode,
      line_name: reg.lineName,
      default_main_title: fixedTitleOrNull(reg),
      organization_slug: reg.organizationSlug,
      // CHECK 고정쌍 — 미지의 종류면 둘 다 NULL(제약 허용).
      experience_category: pair?.category ?? null,
      experience_slot_order: pair?.slot ?? null,
      is_active: true,
    })
    .select("id")
    .single();
  if (createError || !created) {
    throw new LineBridgeError(500, createError?.message ?? "경험 마스터 생성 실패");
  }
  return { id: (created as { id: string }).id, action: "created" as const };
}

async function findOrCreateCompetencyMaster(reg: LineRegistrationDto) {
  const { data: found, error: findError } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("id")
    .eq("organization_slug", reg.organizationSlug!)
    .eq("line_code", reg.lineCode)
    .maybeSingle();
  if (findError) throw new LineBridgeError(500, findError.message);
  if (found) return { id: (found as { id: string }).id, action: "found" as const };

  // 역량 라인 종류(원리/기술/관점/자원)는 마스터 컬럼 부재 — registrations 에만 보존 (임시 한계, 2E 합류).
  const { data: created, error: createError } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .insert({
      line_code: reg.lineCode,
      line_name: reg.lineName,
      main_title: fixedTitleOrNull(reg),
      organization_slug: reg.organizationSlug,
      is_active: true,
    })
    .select("id")
    .single();
  if (createError || !created) {
    throw new LineBridgeError(500, createError?.message ?? "역량 마스터 생성 실패");
  }
  return { id: (created as { id: string }).id, action: "created" as const };
}

async function findOrCreateCareerProject(reg: LineRegistrationDto) {
  // career_projects 는 (org, line_code) unique 제약이 없음 — 동률 시 최신 1건에 연결.
  const { data: foundRows, error: findError } = await supabaseAdmin
    .from("career_projects")
    .select("id")
    .eq("organization_slug", reg.organizationSlug!)
    .eq("line_code", reg.lineCode)
    .order("created_at", { ascending: false })
    .limit(1);
  if (findError) throw new LineBridgeError(500, findError.message);
  const found = (foundRows ?? [])[0] as { id: string } | undefined;
  if (found) return { id: found.id, action: "found" as const };

  const { data: created, error: createError } = await supabaseAdmin
    .from("career_projects")
    .insert({
      line_code: reg.lineCode,
      line_name: reg.lineName,
      default_main_title: fixedTitleOrNull(reg),
      company_name: reg.partnerCompany,
      company_logo_url: reg.companyLogoUrl,
      supervisor_name: reg.managerName,
      supervisor_position: reg.managerPosition,
      supervisor_department: reg.managerJob,
      // 결정 4: 프로필 토큰은 이미지 자산 확정 전까지 supervisor_profile_img 로 옮기지 않음.
      supervisor_profile_img: null,
      organization_slug: reg.organizationSlug,
      output_links: [],
      output_images: [],
      company_homepage_links: [],
      default_output_images: [],
      default_target_user_ids: [],
    })
    .select("id")
    .single();
  if (createError || !created) {
    throw new LineBridgeError(500, createError?.message ?? "career_projects 생성 실패");
  }
  return { id: (created as { id: string }).id, action: "created" as const };
}

export async function bridgeLineRegistration(
  registrationId: string,
): Promise<LineBridgeResult> {
  let reg: LineRegistrationDto;
  try {
    reg = await getLineRegistration(registrationId);
  } catch (e) {
    if (e instanceof LineRegistrationError) throw new LineBridgeError(e.status, e.message);
    throw e;
  }

  if (reg.hub === "info") {
    throw new LineBridgeError(
      400,
      "실무 정보는 마스터가 없어 브리지 대상이 아닙니다 — 기존 개설 화면에서 직접 개설하세요(프리필 지원).",
    );
  }
  if (!reg.organizationSlug) {
    throw new LineBridgeError(
      400,
      "소속 조직이 미지정입니다 — 조직(encre/oranke/phalanx/common)을 지정해야 개설 브리지가 가능합니다.",
    );
  }

  // 멱등: 이미 브리지된 등록이면 기존 연결을 그대로 반환 (마스터 존재 확인).
  const masterTable =
    reg.hub === "experience"
      ? ("cluster4_experience_line_masters" as const)
      : reg.hub === "competency"
        ? ("cluster4_competency_line_masters" as const)
        : ("career_projects" as const);
  if (reg.bridgedMasterId) {
    const { data: still } = await supabaseAdmin
      .from(masterTable)
      .select("id")
      .eq("id", reg.bridgedMasterId)
      .maybeSingle();
    if (still) {
      return {
        registrationId: reg.id,
        hub: reg.hub,
        action: "already_bridged",
        masterTable,
        masterId: reg.bridgedMasterId,
        bridgedAt: reg.bridgedAt ?? new Date().toISOString(),
      };
    }
    // 추적된 마스터가 사라졌으면(롤백 등) 새로 find-or-create 진행.
  }

  const result =
    reg.hub === "experience"
      ? await findOrCreateExperienceMaster(reg)
      : reg.hub === "competency"
        ? await findOrCreateCompetencyMaster(reg)
        : await findOrCreateCareerProject(reg);

  const bridgedAt = new Date().toISOString();
  const { error: trackError } = await supabaseAdmin
    .from("line_registrations")
    .update({ bridged_master_id: result.id, bridged_at: bridgedAt })
    .eq("id", reg.id);
  if (trackError) {
    // 추적 기록 실패 시에도 마스터는 이미 확보됨 — 명시적으로 알린다 (재시도 시 find 로 멱등).
    throw new LineBridgeError(
      500,
      `브리지 추적 기록 실패 (마스터 ${result.id} 확보됨, 재시도 가능): ${trackError.message}`,
    );
  }

  return {
    registrationId: reg.id,
    hub: reg.hub,
    action: result.action,
    masterTable,
    masterId: result.id,
    bridgedAt,
  };
}
