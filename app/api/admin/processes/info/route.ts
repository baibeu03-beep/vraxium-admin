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
import { isProcessHub, type ProcessHub } from "@/lib/adminProcessesTypes";
import {
  ProcessMasterError,
  getProcessInfo,
  getProcessInfoAll,
} from "@/lib/adminProcessesData";
import { publicErrorMessage } from "@/lib/apiError";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const hubRaw = request.nextUrl.searchParams.get("hub")?.trim() ?? null;
  // hub=all → 프로세스 관리 화면의 전체 허브 단일 표.
  const isAll = hubRaw === "all";
  if (!isAll && !isProcessHub(hubRaw)) {
    return Response.json(
      { success: false, error: "hub must be one of all|club|info|experience|competency|career" },
      { status: 400 },
    );
  }

  try {
    const data = isAll ? await getProcessInfoAll() : await getProcessInfo(hubRaw as ProcessHub);
    return Response.json({ success: true, data });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/info GET]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "프로세스 정보를 불러오지 못했습니다.") },
      { status },
    );
  }
}
