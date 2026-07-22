import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  LineOpeningWindowError,
  createLineOpeningWindows,
  isLineOpeningWindowHub,
  listLineOpeningWindows,
} from "@/lib/lineOpeningWindowsData";

// GET /api/admin/line-opening-windows
// 등록된 라인 개설 예외 목록(활성/비활성 모두) — 화면 3.
export async function GET(_request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const windows = await listLineOpeningWindows();
    return Response.json({ success: true, data: { windows } });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list windows",
      },
      { status: 500 },
    );
  }
}

// POST /api/admin/line-opening-windows
// 예외 등록 — 화면 2. body:
//   { week_id, organization_slug?: string|null, hub?: string|null,
//     scope?: "all" | "lines", activity_type_ids?: string[] }
//   organization_slug 미지정/null/"all" → 전체 조직 · hub 미지정/null/"all" → 전체 라인 종류.
//   scope=lines(레거시) → activity_type_ids 각각 1행(info 세부 라인). 기본 scope=all(허브 전체).
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
    return Response.json(
      { success: false, error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const weekId = typeof input.week_id === "string" ? input.week_id.trim() : "";
  if (!weekId) {
    return Response.json(
      { success: false, error: "주차를 선택해주세요." },
      { status: 400 },
    );
  }

  // org: null/"all"/미지정 = 전체 조직, 값이면 유효 조직 검증.
  const orgRaw = typeof input.organization_slug === "string" ? input.organization_slug.trim() : "";
  let organizationSlug: string | null = null;
  if (orgRaw && orgRaw !== "all") {
    if (!isOrganizationSlug(orgRaw)) {
      return Response.json(
        { success: false, error: "소속 클럽을 다시 선택해주세요." },
        { status: 400 },
      );
    }
    organizationSlug = orgRaw;
  }

  // hub(라인 종류): null/"all"/미지정 = 전체, 값이면 info|experience|competency 검증.
  const hubRaw = typeof input.hub === "string" ? input.hub.trim() : "";
  let hub: string | null = null;
  if (hubRaw && hubRaw !== "all") {
    if (!isLineOpeningWindowHub(hubRaw)) {
      return Response.json(
        { success: false, error: "소속 허브를 다시 선택해주세요." },
        { status: 400 },
      );
    }
    hub = hubRaw;
  }

  // 레거시 scope=lines(info 세부 활동유형)도 계속 지원 — 기본은 허브 전체(activityTypeIds=null).
  const scope = input.scope === "lines" ? "lines" : "all";
  let activityTypeIds: string[] | null = null;
  if (scope === "lines") {
    if (!Array.isArray(input.activity_type_ids)) {
      return Response.json(
        { success: false, error: "허용할 라인을 다시 선택해주세요." },
        { status: 400 },
      );
    }
    const ids = input.activity_type_ids.filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
    if (ids.length === 0) {
      return Response.json(
        { success: false, error: "특정 라인 허용 시 최소 1개 선택해주세요" },
        { status: 400 },
      );
    }
    activityTypeIds = ids;
  }

  try {
    const windows = await createLineOpeningWindows({
      weekId,
      activityTypeIds,
      organizationSlug,
      hub,
      createdBy: admin.userId ?? null,
    });
    return Response.json({ success: true, data: { windows } }, { status: 201 });
  } catch (error) {
    if (error instanceof LineOpeningWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/line-opening-windows POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create window",
      },
      { status: 500 },
    );
  }
}
