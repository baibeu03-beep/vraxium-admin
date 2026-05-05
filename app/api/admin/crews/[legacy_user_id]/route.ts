import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug } from "@/lib/organizations";

const TABLE = "legacy_crew_import";

const UPDATABLE_FIELDS = [
  "display_name",
  "team_name",
  "part_name",
  "cumulative_weeks",
  "is_visible",
  "admin_note",
] as const;

type UpdateInput = Partial<Record<(typeof UPDATABLE_FIELDS)[number], unknown>>;

function pickUpdate(body: unknown): UpdateInput {
  if (!body || typeof body !== "object") return {};
  const out: UpdateInput = {};
  for (const key of UPDATABLE_FIELDS) {
    if (key in (body as Record<string, unknown>)) {
      out[key] = (body as Record<string, unknown>)[key];
    }
  }
  return out;
}

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { legacy_user_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const patch = pickUpdate(body);
  const organizationSlug = (body as { organization_slug?: unknown })
    ?.organization_slug;
  const wantsOrgUpdate = organizationSlug !== undefined;

  if (Object.keys(patch).length === 0 && !wantsOrgUpdate) {
    return Response.json(
      { success: false, error: "No updatable fields in body" },
      { status: 400 },
    );
  }

  let updated = null as Record<string, unknown> | null;
  if (Object.keys(patch).length > 0) {
    const { data, error } = await supabaseAdmin
      .from(TABLE)
      .update(patch)
      .eq("legacy_user_id", legacy_user_id)
      .select("*")
      .single();

    if (error) {
      console.error("[admin/crews PATCH]", error);
      const status = error.code === "PGRST116" ? 404 : 500;
      return Response.json(
        { success: false, error: error.message },
        { status },
      );
    }
    updated = data as Record<string, unknown>;
  }

  let warning: string | undefined;
  if (wantsOrgUpdate) {
    if (!isOrganizationSlug(organizationSlug)) {
      return Response.json(
        {
          success: false,
          error: `Unknown organization: ${String(organizationSlug)}`,
        },
        { status: 400 },
      );
    }

    const { data: matched, error: rpcError } = await supabaseAdmin.rpc(
      "set_crew_organization",
      {
        p_legacy_user_id: Number(legacy_user_id),
        p_organization_slug: organizationSlug,
      },
    );

    if (rpcError) {
      console.error("[admin/crews PATCH rpc]", rpcError);
      return Response.json(
        { success: false, error: rpcError.message },
        { status: 500 },
      );
    }

    if (matched === 0) {
      warning =
        "user_profiles에 매칭되는 행이 없어 organization_slug를 설정하지 못했습니다.";
    }
  }

  return Response.json({ success: true, data: updated, warning });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { legacy_user_id } = await params;

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({ is_visible: false })
    .eq("legacy_user_id", legacy_user_id)
    .select("*")
    .single();

  if (error) {
    console.error("[admin/crews DELETE]", error);
    const status = error.code === "PGRST116" ? 404 : 500;
    return Response.json(
      { success: false, error: error.message },
      { status },
    );
  }

  return Response.json({ success: true, data });
}
