import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4LineError,
  createCluster4LineTarget,
  listCluster4LineTargets,
} from "@/lib/adminCluster4LinesData";
import {
  CLUSTER4_LINE_WRITE_ROLES,
  parseCluster4LineTargetCreateBody,
} from "@/lib/adminCluster4LinesTypes";
import {
  assertLineInRequestScope,
  assertUserInRequestScope,
  resolveRequestScope,
} from "@/lib/userScope";
import { parseScopeMode } from "@/lib/userScopeShared";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;
  try {
    // 조회(Read): 라인 자체는 막지 않는다(운영 라인 전부 열람 가능).
    //   대상 크루는 listCluster4LineTargets 가 현재 모집단(QA=test)으로 필터 → T 만 표시.
    const data = await listCluster4LineTargets(
      id,
      parseScopeMode(request.nextUrl.searchParams.get("mode")),
    );
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    const status = (error as { status?: number }).status;
    if (status === 422) {
      return Response.json(
        { success: false, error: error instanceof Error ? error.message : "Scope violation" },
        { status },
      );
    }
    console.error("[admin/cluster4/lines/:id/targets GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list cluster4 targets",
      },
      { status: 500 },
    );
  }
}

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
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCluster4LineTargetCreateBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }
  try {
    await assertLineInRequestScope(request, id, (body as { mode?: unknown })?.mode);
    if (parsed.value.targetMode === "user") {
      await assertUserInRequestScope(request, parsed.value.targetUserId, {
        bodyMode: (body as { mode?: unknown })?.mode,
      });
    }
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const scope = await resolveRequestScope(request, {
      bodyMode: (body as { mode?: unknown }).mode,
    });
    const target = await createCluster4LineTarget(
      id,
      parsed.value,
      admin.userId,
      scope.mode,
    );
    return Response.json({ success: true, data: { target } }, { status: 201 });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines/:id/targets POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create cluster4 target",
      },
      { status: 500 },
    );
  }
}
