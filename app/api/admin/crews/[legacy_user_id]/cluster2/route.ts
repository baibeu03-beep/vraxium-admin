import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster2Error,
  getCluster2ForCrew,
  patchCluster2ForCrew,
  type Cluster2PatchBody,
} from "@/lib/adminCluster2Data";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;

  try {
    const bundle = await getCluster2ForCrew(legacy_user_id);
    if (!bundle) {
      return Response.json(
        { success: false, error: "Crew not found" },
        { status: 404 },
      );
    }
    if (!bundle.userId) {
      // route param 으로 도착한 값이 user_profiles.user_id 와 매칭되지 않을 때
      // 진단을 돕기 위해 stderr 에 정확한 값을 남긴다.
      console.warn(
        "[admin/crews/:id/cluster2 GET] user_profiles 매칭 실패 — routeParam=",
        legacy_user_id,
      );
    }
    return Response.json({ success: true, data: bundle });
  } catch (error) {
    console.error("[admin/crews/:id/cluster2 GET]", error);
    if (error instanceof Cluster2Error) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load cluster2",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  try {
    const { bundle, warnings, applied } = await patchCluster2ForCrew(
      legacy_user_id,
      body as Cluster2PatchBody,
    );
    return Response.json({
      success: true,
      data: bundle,
      warnings: warnings.length > 0 ? warnings : undefined,
      applied,
    });
  } catch (error) {
    console.error("[admin/crews/:id/cluster2 PATCH]", error);
    if (error instanceof Cluster2Error) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update cluster2",
      },
      { status: 500 },
    );
  }
}
