import { NextRequest } from "next/server";
import {
  requireAdmin,
  toAdminErrorResponse,
  ADMIN_READ_ROLES,
} from "@/lib/adminAuth";
import {
  EXPERIENCE_LINE_WRITE_ROLES,
  parseExperienceLineMasterCreateBody,
} from "@/lib/adminExperienceLineTypes";
import {
  listExperienceLineMasters,
  createExperienceLineMaster,
} from "@/lib/adminExperienceLineData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    const result = await listExperienceLineMasters(org);
    return Response.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[experience-line-masters GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(EXPERIENCE_LINE_WRITE_ROLES);
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

  const parsed = parseExperienceLineMasterCreateBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const master = await createExperienceLineMaster(parsed.value);
    return Response.json({ success: true, data: master }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[experience-line-masters POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
