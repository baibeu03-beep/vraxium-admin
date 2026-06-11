import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  cancelCompetencyHub,
  openCompetencyHub,
} from "@/lib/adminCompetencyLineOpening";

// 실무 역량 [라인 개설] — 허브 전체 개설 완료/취소.
//   POST { action: 'open'|'cancel', organization }
//
//   open   = 대상 주차 + org + part_type=competency 라인 is_active=true + snapshot markStale
//   cancel = 동일 조건 라인 is_active=false + snapshot markStale
//
// 기존 라인 생성 흐름(competency-lines POST)·snapshot 생성/조회 로직 무변경. 토글만 수행한다.

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

  const b = (body ?? {}) as Record<string, unknown>;
  const action = b.action;
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";

  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "organization 은 유효한 조직이어야 합니다" },
      { status: 400 },
    );
  }
  if (action !== "open" && action !== "cancel") {
    return Response.json(
      { success: false, error: "action 은 open|cancel 이어야 합니다" },
      { status: 400 },
    );
  }

  try {
    const data =
      action === "open"
        ? await openCompetencyHub({ organization: orgRaw, adminId: admin.userId })
        : await cancelCompetencyHub({ organization: orgRaw, adminId: admin.userId });
    return Response.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/competency/opening POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "처리에 실패했습니다",
      },
      { status },
    );
  }
}
