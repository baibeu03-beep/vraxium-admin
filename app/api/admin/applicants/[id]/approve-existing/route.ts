import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { approveApplicant } from "@/lib/adminApplicantData";
import { isUuid } from "@/lib/isUuid";
import { parseScopeMode } from "@/lib/userScopeShared";
import { publicErrorMessage } from "@/lib/apiError";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const body = (await request.json().catch(() => null)) as {
    user_id?: unknown;
  } | null;
  if (typeof body?.user_id !== "string" || !isUuid(body.user_id)) {
    return Response.json({ error: "user_id must be a UUID" }, { status: 400 });
  }

  try {
    const { id } = await params;
    const result = await approveApplicant(
      id,
      body.user_id,
      parseScopeMode(request.nextUrl.searchParams.get("mode")),
    );
    return Response.json({
      ok: true,
      linked_user_id: result.profile.userId,
      data: result,
    });
  } catch (error) {
    const message =
      publicErrorMessage(error, 500, "가입 요청을 승인하지 못했습니다.");
    const status =
      (error as { status?: number })?.status ??
      (message.includes("not found") ? 404 : message.includes("pending") ? 409 : 400);
    return Response.json({ error: message }, { status });
  }
}
