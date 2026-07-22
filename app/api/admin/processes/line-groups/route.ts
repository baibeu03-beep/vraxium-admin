// /api/admin/processes/line-groups — 프로세스 라인급 마스터 (additive 카탈로그 Phase).
//
// process_line_groups 테이블만 읽고 쓴다. 기존 SoT/주차 성장 계산/snapshot 경로 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  isProcessHub,
  parseProcessLineGroupCreateBody,
} from "@/lib/adminProcessesTypes";
import {
  ProcessMasterError,
  createProcessLineGroup,
  listProcessLineGroups,
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
  if (!isProcessHub(hubRaw)) {
    return Response.json(
      { success: false, error: "소속 허브를 다시 선택해주세요." },
      { status: 400 },
    );
  }

  try {
    const rows = await listProcessLineGroups(hubRaw);
    return Response.json({ success: true, data: rows });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/line-groups GET]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "라인급 정보를 처리하지 못했습니다.") },
      { status },
    );
  }
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const parsed = parseProcessLineGroupCreateBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  try {
    const group = await createProcessLineGroup(parsed.value, admin.userId);
    return Response.json({ success: true, data: group }, { status: 201 });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/line-groups POST]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "라인급 정보를 처리하지 못했습니다.") },
      { status },
    );
  }
}
