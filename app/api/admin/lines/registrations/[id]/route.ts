// /api/admin/lines/registrations/[id] — 통합 등록 관리 (2E-6 선행).
//   GET   — 단건 상세 + openedLineCount (편집 모달 프리필/게이트)
//   PATCH — 부분 수정 + mirror 마스터 정방향 sync. 게이트/검증은 데이터 레이어.
//   DELETE 미제공 — soft 비활성(is_active=false)으로 대체.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isUuid } from "@/lib/isUuid";
import { parseLineRegistrationPatchBody } from "@/lib/adminLineRegistrationsTypes";
import {
  LineRegistrationError,
  getLineRegistrationDetail,
  updateLineRegistration,
} from "@/lib/adminLineRegistrationsData";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return Response.json({ success: false, error: "id must be a UUID" }, { status: 400 });
  }
  try {
    const registration = await getLineRegistrationDetail(id);
    return Response.json({ success: true, data: registration });
  } catch (error) {
    const status = error instanceof LineRegistrationError ? error.status : 500;
    console.error("[lines/registrations/[id] GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return Response.json({ success: false, error: "id must be a UUID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseLineRegistrationPatchBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  try {
    const result = await updateLineRegistration(id, parsed.value);
    return Response.json({
      success: true,
      data: result.registration,
      driftSync: result.driftSync,
    });
  } catch (error) {
    const status = error instanceof LineRegistrationError ? error.status : 500;
    console.error("[lines/registrations/[id] PATCH]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
