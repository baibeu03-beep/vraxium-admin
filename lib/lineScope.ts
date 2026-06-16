import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  isLineVisibleForUserOrg,
  normalizeLineOrg,
  parseLineCodeOrg,
  type LineOrgScope,
} from "@/lib/cluster4LineOrg";
import { getRegistrationOrgByBridgedMasterId } from "@/lib/lineRegistrationLookup";
import type { OrganizationSlug } from "@/lib/organizations";

export type ScopedLinePartType = "info" | "experience" | "competency" | "career";

export type LineScopeSource =
  | "line_code"
  | "registration"
  | "master"
  | "explicit_common"
  | "unknown";

export type LineScopeResolution = {
  org: LineOrgScope | null;
  source: LineScopeSource;
  explicitCommon: boolean;
  unknown: boolean;
};

export type LineScopeInput = {
  partType: ScopedLinePartType;
  lineCode: string | null | undefined;
  registrationOrg?: string | null | undefined;
  masterOrg?: string | null | undefined;
};

export function resolveLineScopeFromValues(input: LineScopeInput): LineScopeResolution {
  const codeOrg = parseLineCodeOrg(input.lineCode);
  if (codeOrg) {
    return {
      org: codeOrg,
      source: codeOrg === "common" ? "explicit_common" : "line_code",
      explicitCommon: codeOrg === "common",
      unknown: false,
    };
  }

  const registrationOrg = normalizeLineOrg(input.registrationOrg);
  if (registrationOrg) {
    return {
      org: registrationOrg,
      source: registrationOrg === "common" ? "explicit_common" : "registration",
      explicitCommon: registrationOrg === "common",
      unknown: false,
    };
  }

  const masterOrg = normalizeLineOrg(input.masterOrg);
  if (masterOrg) {
    return {
      org: masterOrg,
      source: masterOrg === "common" ? "explicit_common" : "master",
      explicitCommon: masterOrg === "common",
      unknown: false,
    };
  }

  return { org: null, source: "unknown", explicitCommon: false, unknown: true };
}

type DbLineScopeRow = {
  part_type: string;
  line_code: string | null;
  experience_line_master_id?: string | null;
  competency_line_master_id?: string | null;
  career_project_id?: string | null;
};

async function fetchMasterOrg(row: DbLineScopeRow): Promise<string | null> {
  if (row.part_type === "experience" && row.experience_line_master_id) {
    const { data } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("organization_slug")
      .eq("id", row.experience_line_master_id)
      .maybeSingle();
    return (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
  }

  if (row.part_type === "competency" && row.competency_line_master_id) {
    const { data } = await supabaseAdmin
      .from("cluster4_competency_line_masters")
      .select("organization_slug")
      .eq("id", row.competency_line_master_id)
      .maybeSingle();
    return (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
  }

  if (row.part_type === "career" && row.career_project_id) {
    const { data } = await supabaseAdmin
      .from("career_projects")
      .select("organization_slug")
      .eq("id", row.career_project_id)
      .maybeSingle();
    return (data as { organization_slug: string | null } | null)?.organization_slug ?? null;
  }

  return null;
}

export async function resolveLineScope(row: DbLineScopeRow): Promise<LineScopeResolution> {
  const partType = row.part_type as ScopedLinePartType;
  const masterId =
    partType === "experience"
      ? row.experience_line_master_id
      : partType === "competency"
        ? row.competency_line_master_id
        : partType === "career"
          ? row.career_project_id
          : null;

  const codeResolution = resolveLineScopeFromValues({
    partType,
    lineCode: row.line_code,
  });
  if (!codeResolution.unknown) return codeResolution;

  const [registrationOrg, masterOrg] = await Promise.all([
    masterId ? getRegistrationOrgByBridgedMasterId(masterId) : Promise.resolve(null),
    fetchMasterOrg(row),
  ]);

  return resolveLineScopeFromValues({
    partType,
    lineCode: row.line_code,
    registrationOrg,
    masterOrg,
  });
}

export function isLineScopeVisibleForOrg(
  resolution: LineScopeResolution,
  userOrg: OrganizationSlug | null,
  opts: { allowUnknown?: boolean } = {},
): boolean {
  return isLineVisibleForUserOrg(resolution.org, userOrg, {
    allowUnknown: opts.allowUnknown === true,
  });
}

