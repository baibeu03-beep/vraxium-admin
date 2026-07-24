import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  EditWindowError,
  listEditWindowsWithUsers,
} from "@/lib/adminEditWindowsData";
import {
  DEFAULT_RESOURCE_KEY,
  isEditableResourceKey,
} from "@/lib/adminEditWindowsTypes";
import { readScopeMode } from "@/lib/userScopeShared";
import { DEFAULT_TABLE_PAGE_SIZE } from "@/lib/tablePagination";

function parseIntParam(
  raw: string | null,
  fallback: number,
  { min, max }: { min: number; max: number },
) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() || null;
  const resourceKeyRaw = params.get("resource_key")?.trim() || DEFAULT_RESOURCE_KEY;

  if (!isEditableResourceKey(resourceKeyRaw)) {
    return Response.json(
      { success: false, error: `Unknown resource_key: ${resourceKeyRaw}` },
      { status: 400 },
    );
  }

  const limit = parseIntParam(params.get("limit"), DEFAULT_TABLE_PAGE_SIZE, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });
  const weekId = params.get("week_id")?.trim() || null;

  try {
    const data = await listEditWindowsWithUsers({
      query: q,
      resourceKey: resourceKeyRaw,
      weekId,
      limit,
      offset,
      // ?mode=test → QA(테스트 유저만). 미지정=operating(실사용자만). QA 누수 차단.
      mode: readScopeMode(params),
    });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/edit-windows GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list edit windows",
      },
      { status: 500 },
    );
  }
}
