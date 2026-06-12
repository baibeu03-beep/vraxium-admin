// /api/admin/processes/info — 프로세스 정보(허브별 액트 목록 + 요약).
//
// 읽기 전용 집계 — process_line_groups · process_acts 만 조회한다.
// snapshot/주차 성장 계산 경로 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isProcessHub } from "@/lib/adminProcessesTypes";
import { ProcessMasterError, getProcessInfo } from "@/lib/adminProcessesData";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const hubRaw = request.nextUrl.searchParams.get("hub")?.trim() ?? null;
  if (!isProcessHub(hubRaw)) {
    return Response.json(
      { success: false, error: "hub must be one of club|info|experience|competency|career" },
      { status: 400 },
    );
  }

  try {
    const data = await getProcessInfo(hubRaw);
    return Response.json({ success: true, data });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/info GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
