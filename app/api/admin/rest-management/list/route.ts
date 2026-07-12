import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { assertAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  loadRestManagementList,
  loadRestManagementOverview,
} from "@/lib/adminRestManagementData";
import { observeApiRoute } from "@/lib/apiObservability";

// GET /api/admin/rest-management/list?organization=&season_key=
//
// 휴식 신청 목록(테이블) — org 필수. season_key 미지정이면 현재(운영) 시즌으로 해소.
// 전체 행 반환(정렬: 주차 최신 → 신청 시점 최신) — 페이지네이션은 클라이언트에서 20개/페이지.
//   summary API 와 동일 데이터 소스/기준. mode 는 집계 모집단을 바꾸지 않으므로 받지 않는다.
export async function GET(request: NextRequest) {
  let admin: AdminContext;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
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
  // 허용 조직 검증 — 허용되지 않은 org 목록 조회 차단(403).
  try {
    await assertAdminOrgAccess(admin, orgParam);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const seasonKeyParam = params.get("season_key")?.trim() || null;

  return observeApiRoute("[admin/rest-management/list GET]", async () => {
    try {
      // season_key 미지정 시 현재(운영) 시즌으로 해소 — summary 와 동일 기준.
      const seasonKey =
        seasonKeyParam ??
        (await loadRestManagementOverview(orgParam, null)).seasonKey;
      const list = seasonKey
        ? await loadRestManagementList(orgParam, seasonKey)
        : { rows: [], total: 0 };
      return Response.json({ success: true, seasonKey, ...list });
    } catch (error) {
      console.error("[admin/rest-management/list GET]", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Failed to load list",
        },
        { status: 500 },
      );
    }
  });
}
