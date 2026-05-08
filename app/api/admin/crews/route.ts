import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { getAdminCrewDtoByLegacyUserId, listAdminCrewDtos } from "@/lib/adminCrewData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import { isOrganizationSlug } from "@/lib/organizations";

const TABLE = "legacy_crew_import";

const WRITABLE_FIELDS = [
  "legacy_user_id",
  "display_name",
  "team_name",
  "part_name",
  "cumulative_weeks",
  "is_visible",
  "admin_note",
] as const;

type CrewInput = Partial<Record<(typeof WRITABLE_FIELDS)[number], unknown>>;

function pickWritable(body: unknown): CrewInput {
  if (!body || typeof body !== "object") return {};
  const out: CrewInput = {};
  for (const key of WRITABLE_FIELDS) {
    if (key in (body as Record<string, unknown>)) {
      out[key] = (body as Record<string, unknown>)[key];
    }
  }
  return out;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization");
  let organization: OrganizationSlug | undefined;

  if (org && !isOrganizationSlug(org)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${org}` },
      { status: 400 },
    );
  }
  if (org) organization = org as OrganizationSlug;

  try {
    const data = await listAdminCrewDtos(organization);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/crews GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load crews",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const payload = pickWritable(body);
  const organizationSlug =
    (body as { organization_slug?: unknown })?.organization_slug ??
    (body as { organization?: unknown })?.organization;

  if (!payload.legacy_user_id) {
    return Response.json(
      { success: false, error: "legacy_user_id is required" },
      { status: 400 },
    );
  }
  if (!payload.display_name || typeof payload.display_name !== "string") {
    return Response.json(
      { success: false, error: "display_name is required" },
      { status: 400 },
    );
  }
  if (!isOrganizationSlug(organizationSlug)) {
    return Response.json(
      { success: false, error: "organization_slug is required" },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    console.error("[admin/crews POST insert]", error);
    const status = error.code === "23505" ? 409 : 500;
    return Response.json({ success: false, error: error.message }, { status });
  }

  const { data: matched, error: rpcError } = await supabaseAdmin.rpc(
    "set_crew_organization",
    {
      p_legacy_user_id: String(payload.legacy_user_id),
      p_organization_slug: organizationSlug,
    },
  );

  const normalized = await getAdminCrewDtoByLegacyUserId(String(payload.legacy_user_id));

  if (rpcError) {
    console.error("[admin/crews POST rpc]", rpcError);
    return Response.json(
      {
        success: true,
        data: normalized ?? data,
        warning: `legacy_crew_import은 저장됐지만 organization 동기화 실패: ${rpcError.message}`,
      },
      { status: 201 },
    );
  }

  return Response.json(
    {
      success: true,
      data: normalized ?? data,
      warning:
        matched === 0
          ? "user_profiles에 매칭되는 행이 없어 organization_slug를 설정하지 못했습니다. 인증 가입 후 다시 시도하세요."
          : undefined,
    },
    { status: 201 },
  );
}
