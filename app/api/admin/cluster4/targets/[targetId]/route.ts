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
    const target = await updateCluster4LineTarget(targetId, parsed.value, admin.userId);
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

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { targetId } = await params;

  try {
    await deleteCluster4LineTarget(targetId);
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
