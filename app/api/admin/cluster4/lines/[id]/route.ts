import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4LineError,
  deleteCluster4Line,
  getCluster4Line,
  updateCluster4Line,
} from "@/lib/adminCluster4LinesData";
import {
  CLUSTER4_LINE_WRITE_ROLES,
  parseCluster4LinePatchBody,
} from "@/lib/adminCluster4LinesTypes";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  try {
    const line = await getCluster4Line(id);
    return Response.json({ success: true, data: { line } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch cluster4 line",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCluster4LinePatchBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const line = await updateCluster4Line(id, parsed.value, admin.userId);
    return Response.json({ success: true, data: { line } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update cluster4 line",
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

  const { id } = await params;

  try {
    await deleteCluster4Line(id);
    return Response.json({ success: true, data: { id } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id DELETE]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete cluster4 line",
      },
      { status: 500 },
    );
  }
}
