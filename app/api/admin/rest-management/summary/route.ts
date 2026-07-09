import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { loadRestManagementOverview } from "@/lib/adminRestManagementData";
import { observeApiRoute } from "@/lib/apiObservability";

// GET /api/admin/rest-management/summary?organization=&season_key=
//
// /admin/rest-management 상단 요약 — org 필수. season_key 미지정이면 현재(운영) 시즌 기본.
// 응답: { success, seasons[], seasonKey, summary{ total, normal, urgent, crews } }.
//   mode 는 이 페이지 집계 모집단을 바꾸지 않으므로 서버에서 받지 않는다(클라이언트가 URL 로만 보존).
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const orgParam = params.get("organization")?.trim() || null;
  if (!isOrganizationSlug(orgParam)) {
    return Response.json(
      { success: false, error: `Unknown organization: ${orgParam ?? ""}` },
      { status: 400 },
    );
  }
  const seasonKey = params.get("season_key")?.trim() || null;

  return observeApiRoute("[admin/rest-management/summary GET]", async () => {
    try {
      const overview = await loadRestManagementOverview(orgParam, seasonKey);
      return Response.json({ success: true, ...overview });
    } catch (error) {
      console.error("[admin/rest-management/summary GET]", error);
      return Response.json(
        {
          success: false,
          error:
            error instanceof Error ? error.message : "Failed to load summary",
        },
        { status: 500 },
      );
    }
  });
}
