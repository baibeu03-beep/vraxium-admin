// /api/admin/cluster4/lines/[id]/opening-note
//
// 실무 정보 라인 개설 [섹션 0] 개설/검수 기록(cluster4_lines.opening_review_note) 전용 엔드포인트.
// 어드민 메타데이터 단일 컬럼만 읽고 쓴다 — 고객 weekly-cards DTO/스냅샷에 무관하며
// snapshot 무효화/재계산을 일절 트리거하지 않는다(데이터 레이어가 invalidate 미호출).

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4LineError,
  getCluster4LineOpeningNote,
  setCluster4LineOpeningNote,
} from "@/lib/adminCluster4LinesData";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";

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
  try {
    const result = await getCluster4LineOpeningNote(id);
    return Response.json({
      success: true,
      data: { note: result.openingReviewNote, isActive: result.isActive },
    });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id/opening-note GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch opening note",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // note: string | null 만 허용.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }
  const raw = (body as Record<string, unknown>).note;
  if (raw !== null && typeof raw !== "string") {
    return Response.json(
      { success: false, error: "note must be a string or null" },
      { status: 400 },
    );
  }

  try {
    const result = await setCluster4LineOpeningNote(id, raw, admin.userId);
    return Response.json({
      success: true,
      data: { note: result.openingReviewNote, isActive: result.isActive },
    });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id/opening-note PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to save opening note",
      },
      { status: 500 },
    );
  }
}
