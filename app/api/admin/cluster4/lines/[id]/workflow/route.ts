import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  Cluster4LineError,
  setCluster4LineWorkflowStage,
} from "@/lib/adminCluster4LinesData";
import {
  CLUSTER4_LINE_WRITE_ROLES,
  isCluster4LineWorkflowAction,
} from "@/lib/adminCluster4LinesTypes";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/admin/cluster4/lines/[id]/workflow
// 실무 경력 라인 개설 역할별 단계 처리: 파트장(입력 완료) / 에이전트(검수 완료) / 팀장(개설).
// 정책: 시간/순서/권한 차단 없음. 기존 owner 게이트(CLUSTER4_LINE_WRITE_ROLES)만 적용.
//       자기 검수 허용, 단계 순서 강제 없음 — 단계 기록만 갱신한다.
export async function POST(request: NextRequest, { params }: Ctx) {
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const action = (body as { action?: unknown } | null)?.action;
  if (!isCluster4LineWorkflowAction(action)) {
    return Response.json(
      {
        success: false,
        error: "action must be one of input_complete|review_complete|open",
      },
      { status: 400 },
    );
  }

  try {
    const line = await setCluster4LineWorkflowStage(id, action, admin.userId);
    return Response.json({ success: true, data: { line } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id/workflow POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update line workflow stage",
      },
      { status: 500 },
    );
  }
}
