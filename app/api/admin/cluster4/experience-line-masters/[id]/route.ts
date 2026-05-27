import { NextRequest } from "next/server";
import {
  requireAdmin,
  toAdminErrorResponse,
  ADMIN_READ_ROLES,
} from "@/lib/adminAuth";
import {
  EXPERIENCE_LINE_WRITE_ROLES,
  parseExperienceLineMasterPatchBody,
} from "@/lib/adminExperienceLineTypes";
import {
  getExperienceLineMaster,
  patchExperienceLineMaster,
  deleteExperienceLineMaster,
} from "@/lib/adminExperienceLineData";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await ctx.params;

  try {
    const master = await getExperienceLineMaster(id);
    if (!master) {
      return Response.json(
        { success: false, error: "Not found" },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: master });
  } catch (error) {
    console.error("[experience-line-masters/[id] GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin(EXPERIENCE_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseExperienceLineMasterPatchBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const master = await patchExperienceLineMaster(id, parsed.value);
    return Response.json({ success: true, data: master });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[experience-line-masters/[id] PATCH]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}

export async function DELETE(_request: NextRequest, ctx: RouteCtx) {
  try {
    await requireAdmin(EXPERIENCE_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await ctx.params;

  try {
    await deleteExperienceLineMaster(id);
    return Response.json({ success: true });
  } catch (error) {
    console.error("[experience-line-masters/[id] DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
