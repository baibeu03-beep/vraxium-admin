// /api/admin/processes/acts — 프로세스 액트 마스터 (additive 카탈로그 Phase).
//
// process_acts 테이블만 읽고 쓴다. 사용자 수행기록/주차 성장 계산/snapshot 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  isProcessHub,
  parseProcessActCreateBody,
} from "@/lib/adminProcessesTypes";
import {
  ProcessMasterError,
  createProcessAct,
  listProcessActs,
} from "@/lib/adminProcessesData";

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
    const rows = await listProcessActs(hubRaw);
    return Response.json({ success: true, data: rows });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/acts GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseProcessActCreateBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  try {
    const act = await createProcessAct(parsed.value, admin.userId);
    return Response.json({ success: true, data: act }, { status: 201 });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/acts POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
