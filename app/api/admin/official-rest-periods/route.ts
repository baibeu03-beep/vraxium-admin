import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  OfficialRestPeriodError,
  createOfficialRestPeriod,
  listOfficialRestPeriods,
} from "@/lib/officialRestPeriodsData";
import {
  OFFICIAL_REST_PERIODS_WRITE_ROLES,
  parseOfficialRestPeriodUpsertBody,
  type OfficialRestPeriodUpsertInput,
} from "@/lib/officialRestPeriodsTypes";

// /api/admin/official-rest-periods
//   GET  — 목록 조회 (read roles). ?includeInactive=1 이면 비활성 포함.
//   POST — 생성 (write roles: owner only).
// 운영자가 등록하면 별도 SQL 없이 다음 조회부터 공식 휴식 판정에 즉시 반영된다
// (판정은 season-weeks/cluster4 조회 시점에 날짜 overlap 으로 라이브 계산).

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const includeInactive =
    request.nextUrl.searchParams.get("includeInactive") === "1";

  try {
    const rows = await listOfficialRestPeriods({ includeInactive });
    return Response.json({
      success: true,
      data: { rows, isSuperAdmin: admin.role === "owner" },
    });
  } catch (error) {
    if (error instanceof OfficialRestPeriodError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/official-rest-periods GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list official_rest_periods",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(OFFICIAL_REST_PERIODS_WRITE_ROLES);
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

  const parsed = parseOfficialRestPeriodUpsertBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  // POST 는 partial=false 이므로 필수 필드가 모두 검증됐다.
  const value = parsed.value;
  const input: OfficialRestPeriodUpsertInput = {
    name: value.name!,
    type: value.type!,
    startDate: value.startDate!,
    endDate: value.endDate!,
    description: value.description ?? null,
    isActive: value.isActive ?? true,
  };

  try {
    const period = await createOfficialRestPeriod(input);
    return Response.json({ success: true, data: { period } }, { status: 201 });
  } catch (error) {
    if (error instanceof OfficialRestPeriodError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/official-rest-periods POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to create official_rest_period",
      },
      { status: 500 },
    );
  }
}
