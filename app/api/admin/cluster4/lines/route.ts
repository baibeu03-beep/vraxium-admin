import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4LineError,
  createCluster4Line,
  listCluster4Lines,
} from "@/lib/adminCluster4LinesData";
import {
  CLUSTER4_LINE_WRITE_ROLES,
  parseCluster4LineCreateBody,
} from "@/lib/adminCluster4LinesTypes";
import { isUuid } from "@/lib/isUuid";

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
  const partType = params.get("partType")?.trim() || null;
  const weekId = params.get("weekId")?.trim() || null;
  const targetMode = params.get("targetMode")?.trim() || null;
  const limit = parseIntParam(params.get("limit"), 50, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });

  if (
    partType !== null &&
    partType !== "info" &&
    partType !== "experience" &&
    partType !== "competency" &&
    partType !== "career"
  ) {
    return Response.json(
      { success: false, error: "partType must be one of info|experience|competency|career" },
      { status: 400 },
    );
  }
  if (weekId !== null && !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "weekId must be a UUID" },
      { status: 400 },
    );
  }
  if (targetMode !== null && targetMode !== "user" && targetMode !== "rule") {
    return Response.json(
      { success: false, error: "targetMode must be one of user|rule" },
      { status: 400 },
    );
  }

  try {
    const data = await listCluster4Lines({
      query: q,
      partType,
      weekId,
      targetMode,
      limit,
      offset,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list cluster4 lines",
      },
      { status: 500 },
    );
  }
}

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
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCluster4LineCreateBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const line = await createCluster4Line(parsed.value, admin.userId);
    return Response.json({ success: true, data: { line } }, { status: 201 });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/lines POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create cluster4 line",
      },
      { status: 500 },
    );
  }
}
