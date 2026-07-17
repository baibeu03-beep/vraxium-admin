import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  selectRegistrationsWithDuration,
  toLineDurationDto,
} from "@/lib/adminLineRegistrationsData";
import type {
  CompetencyLineMasterDto,
  CompetencyLineMasterCreateInput,
  CompetencyLineMasterPatchInput,
} from "@/lib/adminCompetencyLineTypes";

type MasterRow = {
  id: string;
  organization_slug: string;
  line_code: string;
  line_name: string;
  main_title: string | null;
  source_file_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function toDto(row: MasterRow): CompetencyLineMasterDto {
  return {
    id: row.id,
    organizationSlug: row.organization_slug,
    lineCode: row.line_code,
    lineName: row.line_name,
    mainTitle: row.main_title,
    sourceFileName: row.source_file_name,
    isActive: row.is_active,
    // 레거시 마스터 테이블에는 소요 시간 컬럼이 없다 — fallback 경로는 항상 미설정(null → '-').
    estimatedDurationMinutes: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// (2E-6) 개설 드롭다운 목록 — line_registrations 기준 전환.
// 행 집합 = bridged registration (hub='competency'), id = bridged_master_id(기존 FK 체계 유지).
// 필드 SoT = registration. 레거시 필드(sourceFileName/created/updated)는 read-mirror 마스터 보강.
// fallback: registrations 조회 실패 시 기존 마스터 직조 (운영 중단 방지).
export async function listCompetencyLineMasters(
  organizationSlug?: string | null,
): Promise<{ rows: CompetencyLineMasterDto[] }> {
  // 소요 시간은 registrations 에서 함께 읽는다. 컬럼이 없는 환경(마이그 전)에서도 레거시 마스터
  //   fallback 으로 떨어지지 않도록 selectRegistrationsWithDuration 이 컬럼만 빼고 재시도한다.
  const COMP_REG_SELECT =
    "line_code,line_name,main_title,main_title_mode,organization_slug,is_active,bridged_master_id";
  const { data: regs, error: regError } = await selectRegistrationsWithDuration(
    (selectStr) => {
      let q = supabaseAdmin
        .from("line_registrations")
        .select(selectStr)
        .eq("hub", "competency")
        .not("bridged_master_id", "is", null)
        .order("line_code", { ascending: true });
      if (organizationSlug) {
        q = q.eq("organization_slug", organizationSlug);
      }
      return q;
    },
    COMP_REG_SELECT,
  );

  if (!regError) {
    type RegRow = {
      line_code: string;
      line_name: string;
      main_title: string;
      main_title_mode: string;
      organization_slug: string | null;
      is_active: boolean;
      bridged_master_id: string;
      estimated_duration_minutes?: number | null;
    };
    // select 문자열이 동적이라 supabase-js 가 행 타입을 추론하지 못한다(adminLineRegistrationsData 와 동일 관례).
    const regRows = (regs ?? []) as unknown as RegRow[];
    const masterIds = regRows.map((r) => r.bridged_master_id);
    const legacyById = new Map<
      string,
      { source_file_name: string | null; created_at: string; updated_at: string }
    >();
    if (masterIds.length > 0) {
      const { data: masters, error: masterError } = await supabaseAdmin
        .from("cluster4_competency_line_masters")
        .select("id,source_file_name,created_at,updated_at")
        .in("id", masterIds);
      if (masterError) {
        console.warn("[2E-6 comp 목록] mirror 보강 조회 실패", { message: masterError.message });
      } else {
        for (const m of (masters ?? []) as Array<{
          id: string;
          source_file_name: string | null;
          created_at: string;
          updated_at: string;
        }>) {
          legacyById.set(m.id, {
            source_file_name: m.source_file_name,
            created_at: m.created_at,
            updated_at: m.updated_at,
          });
        }
      }
    }
    const rows: CompetencyLineMasterDto[] = regRows.map((r) => {
      const legacy = legacyById.get(r.bridged_master_id) ?? null;
      return {
        id: r.bridged_master_id,
        organizationSlug: r.organization_slug ?? "",
        lineCode: r.line_code,
        lineName: r.line_name,
        mainTitle: r.main_title_mode === "fixed" && r.main_title.trim() ? r.main_title : null,
        sourceFileName: legacy?.source_file_name ?? null,
        isActive: r.is_active,
        estimatedDurationMinutes: toLineDurationDto(r.estimated_duration_minutes),
        createdAt: legacy?.created_at ?? "",
        updatedAt: legacy?.updated_at ?? "",
      };
    });
    return { rows };
  }

  console.warn("[2E-6 comp 목록] registrations 조회 실패 — 마스터 fallback", {
    message: regError.message,
  });
  let query = supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("*")
    .order("line_code", { ascending: true });

  if (organizationSlug) {
    query = query.eq("organization_slug", organizationSlug);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return { rows: ((data ?? []) as unknown as MasterRow[]).map(toDto) };
}

export async function getCompetencyLineMaster(
  id: string,
): Promise<CompetencyLineMasterDto | null> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;
  return toDto(data as unknown as MasterRow);
}

export async function createCompetencyLineMaster(
  input: CompetencyLineMasterCreateInput,
): Promise<CompetencyLineMasterDto> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .insert({
      organization_slug: input.organizationSlug,
      line_code: input.lineCode,
      line_name: input.lineName,
      main_title: input.mainTitle,
      source_file_name: input.sourceFileName,
      is_active: input.isActive,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("이미 존재하는 라인 코드입니다"), { status: 409 });
    }
    throw new Error(error.message);
  }
  return toDto(data as unknown as MasterRow);
}

export async function patchCompetencyLineMaster(
  id: string,
  input: CompetencyLineMasterPatchInput,
): Promise<CompetencyLineMasterDto> {
  const patch: Record<string, unknown> = {};
  if (input.organizationSlug !== undefined) patch.organization_slug = input.organizationSlug;
  if (input.lineCode !== undefined) patch.line_code = input.lineCode;
  if (input.lineName !== undefined) patch.line_name = input.lineName;
  if (input.mainTitle !== undefined) patch.main_title = input.mainTitle;
  if (input.sourceFileName !== undefined) patch.source_file_name = input.sourceFileName;
  if (input.isActive !== undefined) patch.is_active = input.isActive;

  const { data, error } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      throw Object.assign(new Error("이미 존재하는 라인 코드입니다"), { status: 409 });
    }
    throw new Error(error.message);
  }
  return toDto(data as unknown as MasterRow);
}

export async function deleteCompetencyLineMaster(id: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("cluster4_competency_line_masters")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}
