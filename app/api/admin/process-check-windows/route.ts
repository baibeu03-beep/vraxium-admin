import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  ProcessCheckWindowError,
  createProcessCheckWindow,
  isProcessCheckWindowHub,
  listProcessCheckWindows,
} from "@/lib/processCheckWindowsData";

// GET /api/admin/process-check-windows
// 등록된 프로세스 체크 예외 주차 목록(활성/비활성 모두).
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const windows = await listProcessCheckWindows();
    return Response.json({ success: true, data: { windows } });
  } catch (error) {
    if (error instanceof ProcessCheckWindowError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/process-check-windows GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to list windows" },
      { status: 500 },
    );
  }
}

// POST /api/admin/process-check-windows
// 예외 등록. body: { week_id, organization_slug?: string|null, hub?: string|null }
//   organization_slug 미지정/null/"all" → 전체 조직 · hub 미지정/null/"all" → 전체 허브.
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const weekId = typeof input.week_id === "string" ? input.week_id.trim() : "";
  if (!weekId) {
    return Response.json({ success: false, error: "week_id is required" }, { status: 400 });
  }

  // org: null/"all"/미지정 = 전체 조직, 값이면 유효 조직 검증.
  const orgRaw =
    typeof input.organization_slug === "string" ? input.organization_slug.trim() : "";
  let organizationSlug: string | null = null;
  if (orgRaw && orgRaw !== "all") {
    if (!isOrganizationSlug(orgRaw)) {
      return Response.json(
        { success: false, error: "organization_slug 은 유효한 클럽(encre|oranke|phalanx)이어야 합니다" },
        { status: 400 },
      );
    }
    organizationSlug = orgRaw;
  }

  // hub: null/"all"/미지정 = 전체 허브, 값이면 허브 검증.
  const hubRaw = typeof input.hub === "string" ? input.hub.trim() : "";
  let hub: string | null = null;
  if (hubRaw && hubRaw !== "all") {
    if (!isProcessCheckWindowHub(hubRaw)) {
      return Response.json(
        { success: false, error: "hub 은 club|info|experience|competency|career|irregular 중 하나여야 합니다" },
        { status: 400 },
      );
    }
    hub = hubRaw;
  }

  try {
    const window = await createProcessCheckWindow({
      weekId,
      organizationSlug,
      hub,
      createdBy: admin.userId ?? null,
    });
    return Response.json({ success: true, data: { window } }, { status: 201 });
  } catch (error) {
    if (error instanceof ProcessCheckWindowError) {
      return Response.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error("[admin/process-check-windows POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create window" },
      { status: 500 },
    );
  }
}
