import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  Cluster4LineError,
  deleteCluster4LineTarget,
  updateCluster4LineTarget,
} from "@/lib/adminCluster4LinesData";
import {
  CLUSTER4_LINE_WRITE_ROLES,
  parseCluster4LineTargetPatchBody,
} from "@/lib/adminCluster4LinesTypes";
import {
  assertUserInRequestScope,
  getLineTargetUserId,
  resolveRequestScope,
} from "@/lib/userScope";

type Ctx = { params: Promise<{ targetId: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { targetId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCluster4LineTargetPatchBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }
  try {
    const currentUserId = await getLineTargetUserId(targetId);
    if (currentUserId) {
      await assertUserInRequestScope(request, currentUserId, {
        bodyMode: (body as { mode?: unknown })?.mode,
      });
    }
    if (parsed.value.targetUserId) {
      await assertUserInRequestScope(request, parsed.value.targetUserId, {
        bodyMode: (body as { mode?: unknown })?.mode,
      });
    }
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const scope = await resolveRequestScope(request, {
      bodyMode: (body as { mode?: unknown }).mode,
    });
    const target = await updateCluster4LineTarget(
      targetId,
      parsed.value,
      admin.userId,
      scope.mode,
    );
    return Response.json({ success: true, data: { target } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/targets/:targetId PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update cluster4 target",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { targetId } = await params;
  try {
    const currentUserId = await getLineTargetUserId(targetId);
    if (currentUserId) await assertUserInRequestScope(request, currentUserId);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const scope = await resolveRequestScope(request);
    await deleteCluster4LineTarget(targetId, scope.mode);
    return Response.json({ success: true, data: { targetId } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/targets/:targetId DELETE]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete cluster4 target",
      },
      { status: 500 },
    );
  }
}
