import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import {
  CareerEvaluationError,
  listCareerEvaluationTargetsForLine,
  upsertCareerEvaluation,
} from "@/lib/adminCareerEvaluationsData";

// GET /api/admin/cluster4/career-evaluations?line_id=<uuid>
// 평가 탭 로드용 — career 라인의 user-mode 대상자별 현재 평점.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const lineId = request.nextUrl.searchParams.get("line_id");
  if (!lineId) {
    return Response.json({ success: false, error: "line_id is required" }, { status: 400 });
  }

  try {
    const targets = await listCareerEvaluationTargetsForLine(lineId);
    return Response.json({ success: true, data: { targets } });
  } catch (error) {
    if (error instanceof CareerEvaluationError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[career-evaluations GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load evaluations" },
      { status: 500 },
    );
  }
}

// POST /api/admin/cluster4/career-evaluations
// body: { line_target_id, user_id, grade }  → (line_target_id+user_id) upsert.
// 운영자 평가는 작성기간과 무관(지난 주차도 입력/수정 가능).
export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
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

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ success: false, error: "Request body must be a JSON object" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  if (typeof b.line_target_id !== "string") {
    return Response.json({ success: false, error: "line_target_id is required" }, { status: 400 });
  }
  if (typeof b.user_id !== "string") {
    return Response.json({ success: false, error: "user_id is required" }, { status: 400 });
  }
  if (typeof b.grade !== "string") {
    return Response.json({ success: false, error: "grade is required" }, { status: 400 });
  }

  try {
    const evaluation = await upsertCareerEvaluation(
      { lineTargetId: b.line_target_id, userId: b.user_id, grade: b.grade as never },
      admin.userId,
      new Date().toISOString(),
    );
    return Response.json({ success: true, data: { evaluation } }, { status: 200 });
  } catch (error) {
    if (error instanceof CareerEvaluationError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[career-evaluations POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save evaluation" },
      { status: 500 },
    );
  }
}
