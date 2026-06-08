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
} from "@/lib/adminExperienceLineData";
import {
  MASTER_DELETE_BLOCKED_MESSAGE,
  syncRegistrationFromExperienceMaster,
} from "@/lib/lineMasterDriftGuard";

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
    // 2E-2 drift 가드: 마스터 수정분을 연결된 통합 등록(line_registrations)에 동기 반영.
    // best-effort — 실패 시 마스터 수정은 유지하고 경고만 응답에 표면화한다.
    const sync = await syncRegistrationFromExperienceMaster(id);
    return Response.json({
      success: true,
      data: master,
      driftSync: { synced: sync.synced, warning: sync.warning },
    });
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

  // 2E-2 drift 가드: 마스터 직접 삭제 차단 — PATCH is_active=false 로 비활성화 유도.
  // (registrations.bridged_master_id dangling + cluster4_lines FK 보호. 기존 삭제 로직은
  //  가드 해제 시 복원할 수 있도록 adminExperienceLineData.deleteExperienceLineMaster 에 보존.)
  await ctx.params;
  return Response.json(
    { success: false, error: MASTER_DELETE_BLOCKED_MESSAGE },
    { status: 409 },
  );
}
