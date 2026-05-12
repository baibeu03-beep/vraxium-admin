import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  getAdminCrewDtoByLegacyUserId,
  getUsersLegacyUserIdByUserId,
} from "@/lib/adminCrewData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug } from "@/lib/organizations";

const LEGACY_TABLE = "legacy_crew_import";

// legacy_crew_import 에 남아 있는 admin 메타데이터.
// is_visible / admin_note / cumulative_weeks 는 schema 이전 전까지 이 테이블에 유지한다.
// display_name / team_name / part_name 도 화면 호환을 위해 받지만, 권장 채널은
// user_profiles / user_memberships / user_growth_stats 다.
const LEGACY_UPDATABLE_FIELDS = [
  "display_name",
  "team_name",
  "part_name",
  "cumulative_weeks",
  "is_visible",
  "admin_note",
] as const;

type LegacyUpdate = Partial<Record<(typeof LEGACY_UPDATABLE_FIELDS)[number], unknown>>;
type Ctx = { params: Promise<{ legacy_user_id: string }> };

function pickLegacyUpdate(body: unknown): LegacyUpdate {
  if (!body || typeof body !== "object") return {};
  const out: LegacyUpdate = {};
  for (const key of LEGACY_UPDATABLE_FIELDS) {
    if (key in (body as Record<string, unknown>)) {
      out[key] = (body as Record<string, unknown>)[key];
    }
  }
  return out;
}

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;

  try {
    const crew = await getAdminCrewDtoByLegacyUserId(legacy_user_id);
    if (!crew) {
      return Response.json(
        { success: false, error: "Crew not found" },
        { status: 404 },
      );
    }

    return Response.json({ success: true, data: crew });
  } catch (error) {
    console.error("[admin/crews/:id GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load crew",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

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

  const legacyPatch = pickLegacyUpdate(body);
  const organizationSlug = (body as { organization_slug?: unknown })
    ?.organization_slug;
  const wantsOrgUpdate = organizationSlug !== undefined;

  if (Object.keys(legacyPatch).length === 0 && !wantsOrgUpdate) {
    return Response.json(
      { success: false, error: "No updatable fields in body" },
      { status: 400 },
    );
  }

  const existing = await getAdminCrewDtoByLegacyUserId(legacy_user_id);
  if (!existing) {
    return Response.json(
      { success: false, error: "Crew not found" },
      { status: 404 },
    );
  }

  let warning: string | undefined;

  // 1) organization_slug — user_profiles canonical 업데이트
  if (wantsOrgUpdate) {
    if (organizationSlug !== null && !isOrganizationSlug(organizationSlug)) {
      return Response.json(
        {
          success: false,
          error: `Unknown organization: ${String(organizationSlug)}`,
        },
        { status: 400 },
      );
    }

    const { error: orgError } = await supabaseAdmin
      .from("user_profiles")
      .update({ organization_slug: organizationSlug ?? null })
      .eq("user_id", existing.userId);

    if (orgError) {
      console.error("[admin/crews PATCH organization_slug]", orgError);
      return Response.json(
        { success: false, error: orgError.message },
        { status: 500 },
      );
    }
  }

  // 2) legacy_crew_import 메타데이터 (is_visible / admin_note 등)
  if (Object.keys(legacyPatch).length > 0) {
    let legacyUserId = existing.usersLegacyUserId;
    if (!legacyUserId) {
      legacyUserId = await getUsersLegacyUserIdByUserId(existing.userId);
    }

    if (!legacyUserId) {
      return Response.json(
        {
          success: false,
          error:
            "users.legacy_user_id 가 없어 legacy_crew_import 메타데이터를 업데이트할 수 없습니다.",
        },
        { status: 409 },
      );
    }

    const { data: existingLegacy, error: legacySelErr } = await supabaseAdmin
      .from(LEGACY_TABLE)
      .select("legacy_user_id")
      .eq("legacy_user_id", legacyUserId)
      .maybeSingle();
    if (legacySelErr) {
      console.error("[admin/crews PATCH legacy select]", legacySelErr);
      return Response.json(
        { success: false, error: legacySelErr.message },
        { status: 500 },
      );
    }

    if (existingLegacy) {
      const { error: updErr } = await supabaseAdmin
        .from(LEGACY_TABLE)
        .update(legacyPatch)
        .eq("legacy_user_id", legacyUserId);
      if (updErr) {
        console.error("[admin/crews PATCH legacy update]", updErr);
        return Response.json(
          { success: false, error: updErr.message },
          { status: 500 },
        );
      }
    } else {
      const insertPayload = {
        ...legacyPatch,
        legacy_user_id: legacyUserId,
        display_name:
          typeof legacyPatch.display_name === "string" && legacyPatch.display_name
            ? legacyPatch.display_name
            : existing.displayName,
      };
      const { error: insErr } = await supabaseAdmin
        .from(LEGACY_TABLE)
        .insert(insertPayload);
      if (insErr) {
        console.error("[admin/crews PATCH legacy insert]", insErr);
        return Response.json(
          { success: false, error: insErr.message },
          { status: 500 },
        );
      }
      warning =
        "legacy_crew_import 행이 없어 새로 생성했습니다 (운영 메타데이터 보존용).";
    }
  }

  const crew = await getAdminCrewDtoByLegacyUserId(legacy_user_id);
  if (!crew) {
    return Response.json(
      { success: false, error: "Crew not found after update" },
      { status: 404 },
    );
  }

  return Response.json({ success: true, data: crew, warning });
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;

  const existing = await getAdminCrewDtoByLegacyUserId(legacy_user_id);
  if (!existing) {
    return Response.json(
      { success: false, error: "Crew not found" },
      { status: 404 },
    );
  }

  const legacyUserId =
    existing.usersLegacyUserId ??
    (await getUsersLegacyUserIdByUserId(existing.userId));

  if (!legacyUserId) {
    return Response.json(
      {
        success: false,
        error:
          "users.legacy_user_id 가 없어 visibility 를 변경할 수 없습니다.",
      },
      { status: 409 },
    );
  }

  const { data: legacyRow } = await supabaseAdmin
    .from(LEGACY_TABLE)
    .select("legacy_user_id")
    .eq("legacy_user_id", legacyUserId)
    .maybeSingle();

  if (legacyRow) {
    const { error } = await supabaseAdmin
      .from(LEGACY_TABLE)
      .update({ is_visible: false })
      .eq("legacy_user_id", legacyUserId);
    if (error) {
      console.error("[admin/crews DELETE]", error);
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }
  } else {
    const { error } = await supabaseAdmin.from(LEGACY_TABLE).insert({
      legacy_user_id: legacyUserId,
      display_name: existing.displayName,
      is_visible: false,
    });
    if (error) {
      console.error("[admin/crews DELETE legacy insert]", error);
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }
  }

  const crew = await getAdminCrewDtoByLegacyUserId(legacy_user_id);
  return Response.json({ success: true, data: crew });
}
