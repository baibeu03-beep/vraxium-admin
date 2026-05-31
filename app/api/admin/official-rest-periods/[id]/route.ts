import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  OfficialRestPeriodError,
  deleteOfficialRestPeriod,
  getOfficialRestPeriod,
  updateOfficialRestPeriod,
} from "@/lib/officialRestPeriodsData";
import {
  OFFICIAL_REST_PERIODS_WRITE_ROLES,
  parseOfficialRestPeriodUpsertBody,
} from "@/lib/officialRestPeriodsTypes";

// /api/admin/official-rest-periods/[id]
//   GET    — 단건 조회 (read roles)
//   PATCH  — 수정/비활성화 (write roles: owner only). 부분 갱신 허용.
//   DELETE — 삭제 (write roles: owner only). 영구 삭제(비활성화는 PATCH is_active=false).

type Ctx = { params: Promise<{ id: string }> };

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
    const period = await getOfficialRestPeriod(id);
    return Response.json({ success: true, data: { period } });
  } catch (error) {
    if (error instanceof OfficialRestPeriodError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/official-rest-periods/:id GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch official_rest_period",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(OFFICIAL_REST_PERIODS_WRITE_ROLES);
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

  const parsed = parseOfficialRestPeriodUpsertBody(body, { partial: true });
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const period = await updateOfficialRestPeriod(id, parsed.value);
    return Response.json({ success: true, data: { period } });
  } catch (error) {
    if (error instanceof OfficialRestPeriodError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/official-rest-periods/:id PATCH]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update official_rest_period",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(OFFICIAL_REST_PERIODS_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id } = await params;

  try {
    await deleteOfficialRestPeriod(id);
    return Response.json({ success: true, data: { id } });
  } catch (error) {
    if (error instanceof OfficialRestPeriodError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/official-rest-periods/:id DELETE]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete official_rest_period",
      },
      { status: 500 },
    );
  }
}
