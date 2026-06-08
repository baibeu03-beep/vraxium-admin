// POST /api/admin/lines/registrations/[id]/bridge — Phase 2C 개설 브리지.
//
// line_registrations 행을 허브별 마스터(career 는 career_projects)로 find-or-create 연결한다.
//   - 기존 마스터를 찾으면 절대 덮어쓰지 않음 (연결만).
//   - cluster4_lines/snapshot/개설 플로우 무접촉 — 개설은 기존 허브별 화면에서 그대로.
//   - info/org 미지정은 400 (브리지 불가).

import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { LineBridgeError, bridgeLineRegistration } from "@/lib/adminLineBridgeData";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await context.params;
  if (!isUuid(id)) {
    return Response.json(
      { success: false, error: "registration id must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const result = await bridgeLineRegistration(id);
    return Response.json({ success: true, data: result });
  } catch (error) {
    const status = error instanceof LineBridgeError ? error.status : 500;
    console.error("[lines/registrations bridge POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
