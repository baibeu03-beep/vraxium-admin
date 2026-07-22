// Server-only — Phase 2E-2 drift 가드.
//
// 배경: 라인 정의가 마스터(기존 SoT)와 line_registrations(통합 SoT 후보)에 이중 저장된
// 과도기 동안, 운영자가 마스터만 직접 수정하면 2E-1 에서 입증한 diff 0 이 다시 깨진다.
//
// 정책 (2026-06-07):
//   - exp/comp 마스터 신규 생성(POST)·삭제(DELETE) = 차단(409) — 신규는
//     "통합 라인 등록 → 라인 정보 '개설 연결'" 경로로, 제거는 PATCH is_active=false 로 유도.
//   - exp/comp 마스터 수정(PATCH) = 허용 + 연결된 registrations 행 자동 동기화(sync)
//     → drift 자체를 원천 차단. 연결 행이 없으면(브리지/이관 전) 동작 불변.
//   - career_projects 쓰기 = 경고만(soft) — career 는 2E-5 전까지 기존 SoT 가 주력이며
//     sponsor-meta PATCH 는 개설 플로우의 일부라 차단 금지.
//   - 마스터 행 자체는 본 모듈이 절대 수정/삭제하지 않는다 (registrations 쪽만 쓴다).

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const MASTER_CREATE_BLOCKED_MESSAGE =
  "기존 마스터 직접 생성은 중단되었습니다 (2E-2 drift 가드). 신규 라인은 통합 라인 등록(/admin/lines/register)에서 등록한 뒤 라인 정보(/admin/lines/info)의 '개설 연결'을 사용하세요.";

export const MASTER_DELETE_BLOCKED_MESSAGE =
  "기존 마스터 직접 삭제는 중단되었습니다 (2E-2 drift 가드). 라인을 내리려면 수정에서 비활성(is_active=false)으로 전환하세요.";

export const CAREER_DRIFT_NOTICE =
  "안내: 라인 정의 통합(2E) 진행 중입니다. 신규 경력 라인은 통합 라인 등록(/admin/lines/register) 경로 사용을 권장합니다 (기존 경로는 당분간 유지됩니다).";

// experience category(EN) → 등록 line_type(KO). 브리지/백필과 동일 고정 매핑.
const CATEGORY_TO_KO: Record<string, string> = {
  derivation: "도출",
  analysis: "분석",
  evaluation: "평가",
  extension: "확장",
  management: "관리",
};

export type DriftSyncResult = {
  // 연결된 registration 이 있어 동기화를 수행했는지.
  synced: boolean;
  // 동기화 실패/부분 실패 시 운영자 노출용 경고 (마스터 수정 자체는 성공 상태).
  warning: string | null;
};

// 마스터 PATCH 성공 직후 호출 — 마스터 행을 다시 읽어 연결 registration 에 전사한다
// (patch 입력 필드와 무관하게 결정적 full-sync). best-effort: 실패해도 마스터 수정은 유지.
export async function syncRegistrationFromExperienceMaster(
  masterId: string,
): Promise<DriftSyncResult> {
  const { data: m, error } = await supabaseAdmin
    .from("cluster4_experience_line_masters")
    .select(
      "id,line_code,line_name,default_main_title,experience_category,organization_slug,is_active",
    )
    .eq("id", masterId)
    .maybeSingle();
  if (error || !m) {
    return { synced: false, warning: error ? `drift sync: 마스터 재조회 실패 (${error.message})` : null };
  }
  return syncRegistrationRow(masterId, {
    line_code: m.line_code,
    line_name: m.line_name,
    line_type: m.experience_category
      ? CATEGORY_TO_KO[m.experience_category] ?? null
      : null,
    main_title_mode: m.default_main_title?.trim() ? "fixed" : "variable",
    main_title: m.default_main_title?.trim() ? m.default_main_title : "-",
    organization_slug: m.organization_slug,
    is_active: m.is_active,
  });
}

export async function syncRegistrationFromCompetencyMaster(
  masterId: string,
): Promise<DriftSyncResult> {
  const { data: m, error } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("id,line_code,line_name,main_title,organization_slug,is_active")
    .eq("id", masterId)
    .maybeSingle();
  if (error || !m) {
    return { synced: false, warning: error ? `drift sync: 마스터 재조회 실패 (${error.message})` : null };
  }
  return syncRegistrationRow(masterId, {
    line_code: m.line_code,
    line_name: m.line_name,
    // 역량 라인 종류(원리/기술/관점/자원)는 마스터에 원천이 없어 동기화 대상에서 제외(기존 값 보존).
    line_type: null,
    main_title_mode: m.main_title?.trim() ? "fixed" : "variable",
    main_title: m.main_title?.trim() ? m.main_title : "-",
    organization_slug: m.organization_slug,
    is_active: m.is_active,
  });
}

// (2E-5) career_projects 수정 → 연결 registration 역방향 동기화.
// career_projects 는 고객앱 호환 mirror 로 존치하고 입력 SoT 는 registrations —
// 단 기존 career 화면(PATCH/sponsor-meta)이 mirror 를 직접 수정하는 동안 정합을 유지한다.
//   - bridged registration 이 있는 행만 동기화. 미연결(레거시 직접 등록)은 동작 불변.
//   - supervisor_profile_img(URL)→manager_profile_key(토큰) 역매핑 불가 — 동기화 제외
//     (프로필 정책: 업로드 이미지 > 기본 캐릭터 > placeholder — 별도 Phase, 현재 NULL 유지).
//   - career_projects 에 is_active 없음 — is_active 동기화 제외(registration 값 보존).
export async function syncRegistrationFromCareerProject(
  projectId: string,
): Promise<DriftSyncResult> {
  const { data: p, error } = await supabaseAdmin
    .from("career_projects")
    .select(
      "id,line_code,line_name,default_main_title,company_name,company_logo_url,supervisor_name,supervisor_position,supervisor_department,organization_slug",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (error || !p) {
    return { synced: false, warning: error ? `drift sync: career 재조회 실패 (${error.message})` : null };
  }
  const { data: reg, error: findError } = await supabaseAdmin
    .from("line_registrations")
    .select("id")
    .eq("bridged_master_id", projectId)
    .maybeSingle();
  if (findError) {
    return { synced: false, warning: `drift sync: 연결 등록 조회 실패 (${findError.message})` };
  }
  if (!reg) return { synced: false, warning: null }; // 미연결 — 동작 불변(정상)

  const fixed = p.default_main_title?.trim() ? p.default_main_title : null;
  const { error: updateError } = await supabaseAdmin
    .from("line_registrations")
    .update({
      line_code: p.line_code,
      line_name: p.line_name,
      main_title_mode: fixed ? "fixed" : "variable",
      main_title: fixed ?? "-",
      organization_slug: p.organization_slug,
      partner_company: p.company_name?.trim() || null,
      company_logo_url: p.company_logo_url?.trim() || null,
      manager_name: p.supervisor_name?.trim() || null,
      manager_position: p.supervisor_position?.trim() || null,
      manager_job: p.supervisor_department?.trim() || null,
    })
    .eq("id", (reg as { id: string }).id);
  if (updateError) {
    console.warn("[2E-5 drift guard] career registrations sync 실패", {
      projectId,
      message: updateError.message,
    });
    return {
      synced: false,
      warning: `career_projects 는 수정되었으나 통합 등록 동기화에 실패했습니다: ${updateError.message}`,
    };
  }
  return { synced: true, warning: null };
}

async function syncRegistrationRow(
  masterId: string,
  fields: {
    line_code: string;
    line_name: string;
    line_type: string | null; // null = 동기화 제외 (기존 값 보존)
    main_title_mode: "fixed" | "variable";
    main_title: string;
    organization_slug: string;
    is_active: boolean;
  },
): Promise<DriftSyncResult> {
  const { data: reg, error: findError } = await supabaseAdmin
    .from("line_registrations")
    .select("id")
    .eq("bridged_master_id", masterId)
    .maybeSingle();
  if (findError) {
    return { synced: false, warning: `drift sync: 연결 등록 조회 실패 (${findError.message})` };
  }
  if (!reg) {
    // 브리지/이관 전 마스터 — 동기화 대상 없음 (정상).
    return { synced: false, warning: null };
  }

  const payload: Record<string, unknown> = {
    line_code: fields.line_code,
    line_name: fields.line_name,
    main_title_mode: fields.main_title_mode,
    main_title: fields.main_title,
    organization_slug: fields.organization_slug,
    is_active: fields.is_active,
  };
  if (fields.line_type !== null) payload.line_type = fields.line_type;

  const { error: updateError } = await supabaseAdmin
    .from("line_registrations")
    .update(payload)
    .eq("id", (reg as { id: string }).id);
  if (updateError) {
    // 예: (hub, org, line_code) partial unique 충돌 — 마스터 수정은 유지하고 경고만 표면화.
    console.warn("[2E-2 drift guard] registrations sync 실패", {
      masterId,
      message: updateError.message,
    });
    return {
      synced: false,
      warning: `마스터는 수정되었으나 통합 등록(line_registrations) 동기화에 실패했습니다 — diff 감시 스크립트로 확인 필요: ${updateError.message}`,
    };
  }
  return { synced: true, warning: null };
}

// ─────────────────────────────────────────────────────────────────────────
// (관리 기능 — 2E-6 선행) registration → mirror 마스터 정방향 sync.
// registration 이 입력 SoT — 운영자의 명시적 등록 수정을 mirror 에 전파한다.
// (2C "브리지 find 시 무덮어쓰기" 원칙은 브리지 한정 — 명시적 수정 전파는 mirror 의 정의.)
// 직접 DB write 라 기존 역방향 sync(2E-2/2E-5)와 핑퐁/재귀 없음. 미브리지 행은 no-op.
// ─────────────────────────────────────────────────────────────────────────

import type { LineRegistrationDto } from "@/lib/adminLineRegistrationsTypes";

export async function syncMasterFromRegistration(
  reg: LineRegistrationDto,
): Promise<DriftSyncResult> {
  // 정보 허브 — mirror 대상 없음. activity_types(고정 9종)의 name/line_code 는 고객 앱 라벨과
  //   과거 개설/주차/snapshot 이 매달린 정본이므로 **등록 원장 값으로 절대 덮지 않는다**.
  //   등록 원장의 라인명/코드는 화면에서 registeredLineName/registeredLineCode 로만 보여준다.
  if (reg.hub === "info") return { synced: false, warning: null };
  if (!reg.bridgedMasterId) return { synced: false, warning: null }; // 미브리지 — 정상

  const fixedTitle = reg.mainTitleMode === "fixed" && reg.mainTitle.trim() ? reg.mainTitle : null;

  let table: string;
  let payload: Record<string, unknown>;
  if (reg.hub === "experience") {
    const pair = KO_TO_EXPERIENCE_PAIR[reg.lineType] ?? null;
    table = "cluster4_experience_line_masters";
    payload = {
      line_code: reg.lineCode,
      line_name: reg.lineName,
      default_main_title: fixedTitle,
      organization_slug: reg.organizationSlug,
      experience_category: pair?.category ?? null,
      experience_slot_order: pair?.slot ?? null,
      is_active: reg.isActive,
    };
  } else if (reg.hub === "competency") {
    table = "cluster4_competency_line_masters";
    payload = {
      line_code: reg.lineCode,
      line_name: reg.lineName,
      main_title: fixedTitle,
      organization_slug: reg.organizationSlug,
      is_active: reg.isActive,
      // 라인 종류(원리/기술/관점/자원)는 마스터 컬럼 부재 — registration 에만 보존(기존 한계).
    };
  } else {
    table = "career_projects";
    payload = {
      line_code: reg.lineCode,
      line_name: reg.lineName,
      default_main_title: fixedTitle,
      organization_slug: reg.organizationSlug,
      company_name: reg.partnerCompany,
      company_logo_url: reg.companyLogoUrl,
      supervisor_name: reg.managerName,
      supervisor_position: reg.managerPosition,
      supervisor_department: reg.managerJob,
      // supervisor_profile_img: 프로필 Phase 보류 — NULL/기존값 유지(미접촉).
      // is_active: career_projects 에 컬럼 부재 — 제외.
    };
  }

  const { error } = await supabaseAdmin.from(table).update(payload).eq("id", reg.bridgedMasterId);
  if (error) {
    console.warn("[관리기능 drift guard] mirror sync 실패", {
      registrationId: reg.id,
      table,
      message: error.message,
    });
    return {
      synced: false,
      warning: `등록은 수정되었으나 mirror 마스터(${table}) 동기화에 실패했습니다 — diff 스크립트 확인 필요: ${error.message}`,
    };
  }
  return { synced: true, warning: null };
}

// 등록 line_type(KO) → experience category/slot — 마스터 CHECK 고정쌍
// (브리지/2D 백필/2E-4 룩업과 동일 매핑, 본 파일의 CATEGORY_TO_KO 역방향).
const KO_TO_EXPERIENCE_PAIR: Record<string, { category: string; slot: number }> = {
  도출: { category: "derivation", slot: 1 },
  분석: { category: "analysis", slot: 2 },
  평가: { category: "evaluation", slot: 3 },
  확장: { category: "extension", slot: 4 },
  관리: { category: "management", slot: 5 },
};
