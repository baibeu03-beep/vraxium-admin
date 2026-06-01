// GET /api/admin/week-recognitions
//
// 어드민 조회 전용 — 특정 주차 또는 시즌 기준으로 사용자별 주차 인정 상태를 조회한다.
// 수정 기능 없음(GET only). 계산 로직은 lib/adminWeekRecognitionsData 에서 단순 조합.
//
// query params: season_key, week_id, organization_slug, status, search (모두 선택).

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getWeekRecognitions } from "@/lib/adminWeekRecognitionsData";
import { isWeekRecognitionStatus } from "@/lib/adminWeekRecognitionsTypes";
import { isOrganizationSlug } from "@/lib/organizations";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const seasonKey = params.get("season_key")?.trim() || null;
  const weekId = params.get("week_id")?.trim() || null;
  const organizationSlug = params.get("organization_slug")?.trim() || null;
  const status = params.get("status")?.trim() || null;
  const search = params.get("search")?.trim() || null;

  if (organizationSlug && !isOrganizationSlug(organizationSlug)) {
    return Response.json(
      { success: false, error: `Unknown organization_slug: ${organizationSlug}` },
      { status: 400 },
    );
  }

  if (status && !isWeekRecognitionStatus(status)) {
    return Response.json(
      { success: false, error: `Unknown status: ${status}` },
      { status: 400 },
    );
  }

  try {
    const data = await getWeekRecognitions({
      seasonKey,
      weekId,
      organizationSlug,
      status,
      search,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/week-recognitions GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load week recognitions.",
      },
      { status: 500 },
    );
  }
}
