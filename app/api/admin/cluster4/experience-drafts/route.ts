import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import {
  EXPERIENCE_DRAFT_WRITE_ROLES,
  parseExperienceDraftCreateBody,
} from "@/lib/adminExperienceDraftTypes";
import {
  listExperienceDrafts,
  createExperienceDraft,
} from "@/lib/adminExperienceDraftData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sp = request.nextUrl.searchParams;
  const weekId = sp.get("week_id")?.trim() || null;

  if (!weekId) {
    return Response.json(
      { success: false, error: "week_id query parameter is required" },
      { status: 400 },
    );
  }

  try {
    const data = await listExperienceDrafts({
      weekId,
      organizationSlug: sp.get("organization")?.trim() || null,
      team: sp.get("team")?.trim() || null,
      part: sp.get("part")?.trim() || null,
      inputStatus: sp.get("input_status")?.trim() || null,
      reviewStatus: sp.get("review_status")?.trim() || null,
      openStatus: sp.get("open_status")?.trim() || null,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[experience-drafts GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(EXPERIENCE_DRAFT_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseExperienceDraftCreateBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  try {
    const draft = await createExperienceDraft(parsed.value, admin.userId);
    return Response.json({ success: true, data: draft }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[experience-drafts POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
