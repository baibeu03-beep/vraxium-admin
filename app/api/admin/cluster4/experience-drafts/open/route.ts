import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  EXPERIENCE_DRAFT_WRITE_ROLES,
  parseExperienceDraftOpenBody,
} from "@/lib/adminExperienceDraftTypes";
import { openExperienceDrafts } from "@/lib/adminExperienceDraftData";
import {
  assertUserIdsInScope,
  resolveUserScope,
  readScopeMode,
  getExperienceDraftTargetUserIds,
} from "@/lib/userScope";
import { publicErrorMessage } from "@/lib/apiError";

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

  const parsed = parseExperienceDraftOpenBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }
  try {
    const scope = await resolveUserScope(readScopeMode(request.nextUrl.searchParams), null);
    assertUserIdsInScope(
      scope,
      await getExperienceDraftTargetUserIds(parsed.value.draftIds),
    );
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(
          error,
          (error as { status?: number }).status ?? 422,
          "개설에 실패했습니다.",
        ),
      },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const result = await openExperienceDrafts(parsed.value.draftIds, admin.userId);
    return Response.json({
      success: true,
      data: result,
      ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[experience-drafts open POST]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "개설에 실패했습니다.") },
      { status },
    );
  }
}
