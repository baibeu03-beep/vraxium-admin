import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse, ADMIN_READ_ROLES } from "@/lib/adminAuth";
import { COMPETENCY_LINE_WRITE_ROLES } from "@/lib/adminCompetencyLineTypes";
import { listCompetencyLineMasters } from "@/lib/adminCompetencyLineData";
import { MASTER_CREATE_BLOCKED_MESSAGE } from "@/lib/lineMasterDriftGuard";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    const result = await listCompetencyLineMasters(org);
    return Response.json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[competency-line-masters GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function POST(_request: NextRequest) {
  try {
    await requireAdmin(COMPETENCY_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // 2E-2 drift 가드: 마스터 직접 생성 차단 — 통합 라인 등록 → 개설 연결(브리지) 경로로 유도.
  // (기존 생성 로직은 가드 해제 시 복원할 수 있도록 adminCompetencyLineData 에 보존.)
  return Response.json(
    { success: false, error: MASTER_CREATE_BLOCKED_MESSAGE },
    { status: 409 },
  );
}
