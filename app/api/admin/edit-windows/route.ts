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

  const limit = parseIntParam(params.get("limit"), 50, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });

  try {
    const data = await listEditWindowsWithUsers({
      query: q,
      resourceKey: resourceKeyRaw,
      limit,
      offset,
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
