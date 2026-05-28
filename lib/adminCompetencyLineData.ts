import { supabaseAdmin } from "@/lib/supabaseAdmin";
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listCompetencyLineMasters(
  organizationSlug?: string | null,
): Promise<{ rows: CompetencyLineMasterDto[] }> {
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
