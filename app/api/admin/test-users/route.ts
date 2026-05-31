// GET /api/admin/test-users
//
// 데모/테스트 모드용 더미 유저 목록. 데모 모드(개발/스테이징, isDemoModeEnabled)
// 에서만 응답하며, 운영에서는 403. 반환 대상은 test_user_markers 에 등재된
// 테스트 유저로 한정되어 실 운영 사용자 전체가 노출되지 않는다.
//
// 응답: { success: true, data: TestUserDto[] }
//   각 row: userId, name, email, seasonName, teamName, partName, roleLabel,
//           status, growthStatus, organizationSlug, organizationName, userType,
//           legacyUserId

import { isDemoModeEnabled } from "@/lib/demoMode";
import { listTestUsers } from "@/lib/testUsers";

export async function GET() {
  if (!isDemoModeEnabled()) {
    return Response.json(
      { success: false, error: "Demo mode is disabled." },
      { status: 403 },
    );
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
