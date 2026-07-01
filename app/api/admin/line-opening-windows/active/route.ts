import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  LineOpeningWindowError,
  isLineOpeningWindowHub,
  listActiveExceptionWeeks,
} from "@/lib/lineOpeningWindowsData";
import { isOrganizationSlug } from "@/lib/organizations";

// GET /api/admin/line-opening-windows/active[?org=&hub=]
// 라인 개설 폼(섹션 0) 연동용 — 현재 활성 예외가 가리키는 주차 서술자 + 허용 라인.
//   ?org·?hub 로 스코프(미지정=전체/전체 예외만). 개설 폼 주차 드롭다운에 "자동 정책 주차" 와
//   함께 그 org·라인종류에 적용되는 "예외 허용 주차" 를 표시하기 위함.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const orgParam = request.nextUrl.searchParams.get("org")?.trim() || null;
    const org = isOrganizationSlug(orgParam) ? orgParam : null;
    const hubParam = request.nextUrl.searchParams.get("hub")?.trim() || null;
    const hub = isLineOpeningWindowHub(hubParam) ? hubParam : null;
    const weeks = await listActiveExceptionWeeks(org, hub);
    return Response.json({ success: true, data: { weeks } });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows/active GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list active windows",
      },
      { status: 500 },
    );
  }
}
