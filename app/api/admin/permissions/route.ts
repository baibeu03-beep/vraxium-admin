import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  PermissionsError,
  getPermissionsMatrix,
} from "@/lib/adminPermissionsData";

// GET /api/admin/permissions
// → 권한 매트릭스 페이지가 한 번에 렌더링하는 데 필요한 데이터를 모두 반환.
// 조회는 admin_users 의 read role(owner/admin/viewer) 전체가 가능.
// 실제 토글 가능 여부는 응답의 isSuperAdmin 으로 클라이언트가 결정한다.
export async function GET() {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // admin_users.role='owner' = logical super_admin.
  // (변경 단일 지점: PATCH /api/admin/permissions/[key] requireAdmin(['owner']).)
  const isSuperAdmin = admin.role === "owner";

  try {
    const data = await getPermissionsMatrix({ isSuperAdmin });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof PermissionsError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/permissions GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load permissions",
      },
      { status: 500 },
    );
  }
}
