// GET /api/admin/test-users
//
// 어드민 테스트 유저 관리 목록. 이 라우트는 "크루 페이지 데모 모드"(lib/demoMode,
// isDemoModeEnabled)와 분리된 어드민 전용 조회다 — 운영에서 고객 데모 모드가 꺼져
// 있어도(=ENABLE_DEMO_MODE 미설정) 어드민은 이 목록을 볼 수 있어야 한다.
//   → 따라서 게이트는 isDemoModeEnabled() 가 아니라 requireAdmin(ADMIN_READ_ROLES).
//     (운영 demoMode 차단 정책 자체는 lib/demoMode 에 그대로 두고 건드리지 않는다.)
// 반환 대상은 test_user_markers 에 등재된 테스트 유저로 한정되어 실 운영 사용자
// 전체가 노출되지 않는다.
//
// 응답: { success: true, data: TestUserDto[] }
//   각 row: userId, name, email, seasonName, teamName, partName, roleLabel,
//           status, growthStatus, organizationSlug, organizationName, userType,
//           legacyUserId

import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { listTestUsers } from "@/lib/testUsers";

export async function GET() {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const data = await listTestUsers();
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/test-users GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load test users.",
      },
      { status: 500 },
    );
  }
}
