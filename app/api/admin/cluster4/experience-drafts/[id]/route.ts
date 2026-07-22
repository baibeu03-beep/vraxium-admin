import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  EXPERIENCE_DRAFT_WRITE_ROLES,
  parseExperienceDraftPatchBody,
} from "@/lib/adminExperienceDraftTypes";
import { updateExperienceDraft } from "@/lib/adminExperienceDraftData";
import {
  assertUsersInRequestScope,
  getExperienceDraftTargetUserIds,
} from "@/lib/userScope";
import { publicErrorMessage } from "@/lib/apiError";

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, ctx: RouteCtx) {
  let admin;
  try {
    admin = await requireAdmin(EXPERIENCE_DRAFT_WRITE_ROLES);
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseExperienceDraftPatchBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }
  try {
    await assertUsersInRequestScope(
      request,
      await getExperienceDraftTargetUserIds([id]),
      { bodyMode: (body as { mode?: unknown }).mode },
    );
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(
          error,
          (error as { status?: number }).status ?? 422,
          "실무 경험 초안을 처리하지 못했습니다.",
        ),
      },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const draft = await updateExperienceDraft(id, parsed.value, admin.userId);
    return Response.json({ success: true, data: draft });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[experience-drafts PATCH]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "실무 경험 초안을 처리하지 못했습니다.") },
      { status },
    );
  }
}
