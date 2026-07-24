import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4LineError,
  listCluster4OpenedLines,
} from "@/lib/adminCluster4LinesData";
import { DEFAULT_TABLE_PAGE_SIZE } from "@/lib/tablePagination";

// ─────────────────────────────────────────────────────────────────────────
// GET /api/admin/cluster4/lines/history
//   어드민 전용 "라인 개설 이력" 조회. 단순 DB read 다 — weekly-cards 스냅샷을
//   읽지도 쓰지도 않고 재계산을 트리거하지 않는다(snapshot-only 구조 무영향).
//
// query parameters:
//   status        = past | current | all          (기본 all)
//   partType      = info | experience | competency | career   (허브 필터; hubId 대용)
//   activityTypeId= 활동 유형 id                    (카테고리 필터; categoryId 대용)
//   seasonKey     = 예) 2026-spring                 (시즌 필터; seasonName/Id 대용)
//   q             = 라인명(main_title) 또는 라인 id 검색
//   limit/offset  = 페이지네이션 (limit 1~200, 기본 20)
//
// 정렬: startDate(submission_opens_at) desc → createdAt desc.
// ─────────────────────────────────────────────────────────────────────────

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
  const statusRaw = (params.get("status")?.trim() || "all").toLowerCase();
  const partType = params.get("partType")?.trim() || null;
  const activityTypeId = params.get("activityTypeId")?.trim() || null;
  const seasonKey = params.get("seasonKey")?.trim() || null;
  const q = params.get("q")?.trim() || null;
  const limit = parseIntParam(params.get("limit"), DEFAULT_TABLE_PAGE_SIZE, { min: 1, max: 200 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });

  if (statusRaw !== "past" && statusRaw !== "current" && statusRaw !== "all") {
    return Response.json(
      { success: false, error: "status must be one of past|current|all" },
      { status: 400 },
    );
  }
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

  try {
    const data = await listCluster4OpenedLines({
      status: statusRaw as "past" | "current" | "all",
      partType: partType as
        | "info"
        | "experience"
        | "competency"
        | "career"
        | null,
      activityTypeId,
      seasonKey,
      query: q,
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
    console.error("[admin/cluster4/lines/history GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list cluster4 line history",
      },
      { status: 500 },
    );
  }
}
