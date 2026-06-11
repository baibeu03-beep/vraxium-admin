import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4LineError,
  deleteCluster4Line,
  getCluster4Line,
  updateCluster4Line,
} from "@/lib/adminCluster4LinesData";
import {
  CLUSTER4_LINE_WRITE_ROLES,
  parseCluster4LinePatchBody,
} from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { insertOpeningLogForLine } from "@/lib/adminCluster4OpeningLogs";

type Ctx = { params: Promise<{ id: string }> };

// info 라인의 week_id 는 cluster4_line_targets 에 있다(라인 자체엔 없음). 첫 타깃 기준.
async function resolveLineWeekId(lineId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("line_id", lineId)
    .limit(1);
  return (data?.[0] as { week_id: string | null } | undefined)?.week_id ?? null;
}

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
    const line = await getCluster4Line(id);
    return Response.json({ success: true, data: { line } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to fetch cluster4 line",
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

  const parsed = parseCluster4LinePatchBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  // [섹션 0] 로그창: info 라인 is_active 전환을 개설/취소 로그로 남기기 위해 직전 상태를 읽어둔다.
  const { data: beforeRow } = await supabaseAdmin
    .from("cluster4_lines")
    .select("is_active,part_type,activity_type_id")
    .eq("id", id)
    .maybeSingle();
  const before = beforeRow as {
    is_active: boolean;
    part_type: string;
    activity_type_id: string | null;
  } | null;

  try {
    const line = await updateCluster4Line(id, parsed.value, admin.userId);
    // is_active 변동(개설상태 ↑↓) 시 best-effort 로그 — false→true=[개설 완료], true→false=[개설 취소].
    // (snapshot 무관·본 동작과 분리. 로그 실패가 PATCH 를 깨지 않는다.)
    const nextActive = parsed.value.isActive;
    if (
      before?.part_type === "info" &&
      typeof nextActive === "boolean" &&
      before.is_active !== nextActive
    ) {
      const weekId = await resolveLineWeekId(id);
      await insertOpeningLogForLine({
        action: nextActive ? "open" : "cancel",
        lineId: id,
        weekId,
        activityTypeId: before.activity_type_id,
        changedBy: admin.userId,
      });
    }
    return Response.json({ success: true, data: { line } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update cluster4 line",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  // [섹션 0] 로그창: 삭제 후엔 조회 불가하므로 직전 상태/주차를 확보. 활성 info 라인 삭제 = [개설 취소].
  const { data: beforeRow } = await supabaseAdmin
    .from("cluster4_lines")
    .select("is_active,part_type,activity_type_id")
    .eq("id", id)
    .maybeSingle();
  const before = beforeRow as {
    is_active: boolean;
    part_type: string;
    activity_type_id: string | null;
  } | null;
  const cancelLog = before?.part_type === "info" && before.is_active === true;
  const weekIdForLog = cancelLog ? await resolveLineWeekId(id) : null;

  try {
    await deleteCluster4Line(id);
    if (cancelLog) {
      await insertOpeningLogForLine({
        action: "cancel",
        lineId: id,
        weekId: weekIdForLog,
        activityTypeId: before?.activity_type_id ?? null,
        changedBy: admin.userId,
      });
    }
    return Response.json({ success: true, data: { id } });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id DELETE]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to delete cluster4 line",
      },
      { status: 500 },
    );
  }
}
