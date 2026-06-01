// GET /api/admin/season-participations
//
// 어드민 조회 전용 — 사용자별 시즌 참여/휴식 상태 + 시즌별 주차 상태 요약을 조회한다.
// 수정 기능 없음(GET only). 계산 로직은 lib/adminSeasonParticipationsData 에서 단순 조합.
//
// query params: season_key, organization_slug, status, search (모두 선택).
// status 허용값은 user_season_statuses CHECK 기준 success/rest.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { isSeasonParticipationStatus } from "@/lib/adminSeasonParticipationsTypes";
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
  const organizationSlug = params.get("organization_slug")?.trim() || null;
  const status = params.get("status")?.trim() || null;
  const search = params.get("search")?.trim() || null;

  if (organizationSlug && !isOrganizationSlug(organizationSlug)) {
    return Response.json(
      { success: false, error: `Unknown organization_slug: ${organizationSlug}` },
      { status: 400 },
    );
  }

  if (status && !isSeasonParticipationStatus(status)) {
    return Response.json(
      { success: false, error: `Unknown status: ${status}` },
      { status: 400 },
    );
  }

  try {
    const data = await getSeasonParticipations({
      seasonKey,
      organizationSlug,
      status,
      search,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/season-participations GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load season participations.",
      },
      { status: 500 },
    );
  }
}
