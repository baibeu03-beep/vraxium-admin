import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster3Error,
  getCluster3ForCrew,
  patchCluster3ForCrew,
} from "@/lib/adminCluster3Data";
import type { Cluster3PatchBody } from "@/lib/adminCluster3Types";

// Cluster3 admin — Phase 4: GET + PATCH.
// PATCH body 는 channelCards / outputCards / detailCards 중 한 섹션 이상이 와야 하며
// 각 섹션의 슬롯 길이(16/5/10)와 형식 검증은 patchCluster3ForCrew 가 담당.
// requireAdmin 으로 보호되므로 user_edit_windows (사용자-facing 작성 기간) 와
// 무관하게 저장한다.
// POST / PUT / DELETE 는 의도적으로 export 하지 않는다 → Next 가 405 자동 응답.

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
    const bundle = await getCluster3ForCrew(legacy_user_id);
    if (!bundle.userId) {
      // route param 으로 도착한 값이 user_profiles.user_id 와 매칭되지 않을 때
      // 진단을 돕기 위해 stderr 에 정확한 값을 남긴다.
      console.warn(
        "[admin/crews/:id/cluster3 GET] user_profiles 매칭 실패 — routeParam=",
        legacy_user_id,
      );
    }
    return Response.json({ success: true, data: bundle });
  } catch (error) {
    console.error("[admin/crews/:id/cluster3 GET]", error);
    if (error instanceof Cluster3Error) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load cluster3",
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
    const { bundle, warnings, applied } = await patchCluster3ForCrew(
      legacy_user_id,
      body as Cluster3PatchBody,
    );
    return Response.json({
      success: true,
      data: bundle,
      warnings: warnings.length > 0 ? warnings : undefined,
      applied,
    });
  } catch (error) {
    console.error("[admin/crews/:id/cluster3 PATCH]", error);
    if (error instanceof Cluster3Error) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update cluster3",
      },
      { status: 500 },
    );
  }
}
