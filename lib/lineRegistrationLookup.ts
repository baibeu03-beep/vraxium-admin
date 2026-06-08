// Server-only — Phase 2E-3: 개설 검증/org 판정의 registrations-first 조회 헬퍼.
//
// 계약:
//   - 키 = line_registrations.bridged_master_id (2C 브리지/2D 백필이 기록한 마스터 1:1 연결).
//   - 반환 null = 연결 registration 없음 → 호출부는 **기존 마스터 fallback** 을 그대로 탄다
//     (전환 중 운영 중단 방지 — 2E-3 결정).
//   - 필드 의미는 마스터와 등가로 노출한다: mainTitle 은 variable(변동)이면 null
//     (마스터의 default_main_title/main_title NULL 과 동일 의미 — 2E-1 diff 기준).
//   - 본 모듈은 읽기 전용 — 마스터/registrations 어디에도 쓰지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";

export type RegistrationMasterView = {
  registrationId: string;
  isActive: boolean;
  lineCode: string;
  lineName: string;
  // 고정(fixed)이면 main_title 값, 변동(variable)이면 null — 마스터 타이틀 컬럼과 등가.
  mainTitle: string | null;
  organizationSlug: string | null;
};

// bridged_master_id → registration 등가 뷰. 미연결이면 null (호출부 마스터 fallback).
export async function getRegistrationByBridgedMasterId(
  masterId: string,
): Promise<RegistrationMasterView | null> {
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select("id,line_code,line_name,main_title,main_title_mode,organization_slug,is_active")
    .eq("bridged_master_id", masterId)
    .maybeSingle();
  if (error) {
    // 조회 실패는 fallback 으로 흡수 (기존 마스터 경로가 그대로 동작) — 로그만 남긴다.
    console.warn("[2E-3 registrations lookup] 실패 — 마스터 fallback", {
      masterId,
      message: error.message,
    });
    return null;
  }
  if (!data) return null;
  const row = data as {
    id: string;
    line_code: string;
    line_name: string;
    main_title: string;
    main_title_mode: string;
    organization_slug: string | null;
    is_active: boolean;
  };
  return {
    registrationId: row.id,
    isActive: row.is_active,
    lineCode: row.line_code,
    lineName: row.line_name,
    mainTitle: row.main_title_mode === "fixed" && row.main_title.trim() ? row.main_title : null,
    organizationSlug: row.organization_slug,
  };
}

// org 판정 전용 축약 — registration 의 organization_slug 만. 미연결/org 미지정이면 null
// (호출부는 null 시 기존 마스터 fallback).
export async function getRegistrationOrgByBridgedMasterId(
  masterId: string,
): Promise<string | null> {
  const view = await getRegistrationByBridgedMasterId(masterId);
  return view?.organizationSlug ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// (2E-4) weekly-cards 메타 / lineAvailability / 고객 lines/detail 용 batch 헬퍼.
// registrations-first + "미커버 id 만" 기존 마스터 fallback — 반환 shape 는 기존 마스터
// 쿼리와 등가 (2E-1 diff 0 기준). 전부 읽기 전용.
// ─────────────────────────────────────────────────────────────────────────

// 등록 line_type(KO) → experience category/slot — 마스터 CHECK 고정쌍과 동일
// (adminLineBridgeData / 2D 백필과 같은 매핑).
const KO_TO_EXPERIENCE: Record<string, { category: string; slot: number }> = {
  도출: { category: "derivation", slot: 1 },
  분석: { category: "analysis", slot: 2 },
  평가: { category: "evaluation", slot: 3 },
  확장: { category: "extension", slot: 4 },
  관리: { category: "management", slot: 5 },
};

export type ExperienceMasterMetaView = {
  category: string | null;
  slotOrder: number | null;
  lineName: string | null;
  organizationSlug: string | null;
};

// experience master id 집합 → 메타 (registrations-first, 미커버는 마스터 fallback).
export async function getExperienceMetaByMasterIdsRegFirst(
  ids: string[],
): Promise<Map<string, ExperienceMasterMetaView>> {
  const map = new Map<string, ExperienceMasterMetaView>();
  if (ids.length === 0) return map;

  const { data: regs, error: regError } = await supabaseAdmin
    .from("line_registrations")
    .select("bridged_master_id,line_type,line_name,organization_slug")
    .eq("hub", "experience")
    .in("bridged_master_id", ids);
  if (regError) {
    console.warn("[2E-4 registrations lookup] experience meta 실패 — 전량 마스터 fallback", {
      message: regError.message,
    });
  } else {
    for (const r of (regs ?? []) as Array<{
      bridged_master_id: string;
      line_type: string;
      line_name: string;
      organization_slug: string | null;
    }>) {
      const pair = KO_TO_EXPERIENCE[r.line_type] ?? null;
      map.set(r.bridged_master_id, {
        category: pair?.category ?? null,
        slotOrder: pair?.slot ?? null,
        lineName: r.line_name,
        organizationSlug: r.organization_slug,
      });
    }
  }

  const missing = ids.filter((id) => !map.has(id));
  if (missing.length > 0) {
    const { data: masters, error: masterError } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("id,experience_category,experience_slot_order,line_name,organization_slug")
      .in("id", missing);
    if (masterError) {
      console.warn("[2E-4 master fallback] experience meta 실패", {
        message: masterError.message,
      });
    } else {
      for (const m of (masters ?? []) as Array<{
        id: string;
        experience_category: string | null;
        experience_slot_order: number | null;
        line_name: string | null;
        organization_slug: string | null;
      }>) {
        map.set(m.id, {
          category: m.experience_category,
          slotOrder: m.experience_slot_order,
          lineName: m.line_name,
          organizationSlug: m.organization_slug,
        });
      }
    }
  }
  return map;
}

export type CompetencyMasterMetaView = {
  lineName: string | null;
  organizationSlug: string | null;
};

// competency master id 집합 → 메타 (registrations-first + 마스터 fallback).
export async function getCompetencyMetaByMasterIdsRegFirst(
  ids: string[],
): Promise<Map<string, CompetencyMasterMetaView>> {
  const map = new Map<string, CompetencyMasterMetaView>();
  if (ids.length === 0) return map;

  const { data: regs, error: regError } = await supabaseAdmin
    .from("line_registrations")
    .select("bridged_master_id,line_name,organization_slug")
    .eq("hub", "competency")
    .in("bridged_master_id", ids);
  if (regError) {
    console.warn("[2E-4 registrations lookup] competency meta 실패 — 전량 마스터 fallback", {
      message: regError.message,
    });
  } else {
    for (const r of (regs ?? []) as Array<{
      bridged_master_id: string;
      line_name: string;
      organization_slug: string | null;
    }>) {
      map.set(r.bridged_master_id, {
        lineName: r.line_name,
        organizationSlug: r.organization_slug,
      });
    }
  }

  const missing = ids.filter((id) => !map.has(id));
  if (missing.length > 0) {
    const { data: masters, error: masterError } = await supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("id,line_name,organization_slug")
      .in("id", missing);
    if (masterError) {
      console.warn("[2E-4 master fallback] competency meta 실패", {
        message: masterError.message,
      });
    } else {
      for (const m of (masters ?? []) as Array<{
        id: string;
        line_name: string | null;
        organization_slug: string | null;
      }>) {
        map.set(m.id, { lineName: m.line_name, organizationSlug: m.organization_slug });
      }
    }
  }
  return map;
}

// experience master id 집합 → slot_order 맵 (lineAvailability 3슬롯/4넘버 판정용).
export async function getExperienceSlotsByMasterIdsRegFirst(
  ids: string[],
): Promise<Map<string, number>> {
  const meta = await getExperienceMetaByMasterIdsRegFirst(ids);
  const map = new Map<string, number>();
  for (const [id, m] of meta) {
    if (m.slotOrder != null) map.set(id, m.slotOrder);
  }
  return map;
}

// 단건 — 고객 lines/detail 의 category/slot 메타 (registrations-first + 마스터 fallback).
export async function getExperienceCategorySlotByMasterIdRegFirst(
  masterId: string,
): Promise<{ category: string | null; slotOrder: number | null }> {
  const meta = await getExperienceMetaByMasterIdsRegFirst([masterId]);
  const m = meta.get(masterId);
  return { category: m?.category ?? null, slotOrder: m?.slotOrder ?? null };
}

// line_name → experience master id (레거시 통합 마스터 식별). registrations-first —
// 연결 행의 bridged_master_id 를 그대로 돌려준다(라인 FK 는 마스터 id 체계 유지).
// 미연결이면 null (호출부 마스터 fallback).
export async function findExperienceMasterIdByLineNameRegFirst(
  lineName: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select("bridged_master_id")
    .eq("hub", "experience")
    .eq("line_name", lineName)
    .not("bridged_master_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn("[2E-4 registrations lookup] line_name 검색 실패 — 마스터 fallback", {
      lineName,
      message: error.message,
    });
    return null;
  }
  return (data as { bridged_master_id: string } | null)?.bridged_master_id ?? null;
}
