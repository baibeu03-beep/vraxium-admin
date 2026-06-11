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
//   POST { action: 'open'|'cancel', organization, output_link_1?, output_description? }
//
//   open   = 대상 주차 + org + part_type=competency 라인 is_active=true
//            + (링크 입력 시) 주차 공통 아웃풋(output_link_1/output_links[0])을 모든 라인칸에 반영
//            + snapshot markStale
//   cancel = 동일 조건 라인 is_active=false + 아웃풋 원복(직전값 복원) + snapshot markStale
//
// 기존 라인 생성 흐름(competency-lines POST)·snapshot 생성/조회 로직 무변경.

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

  const outputLink1 =
    typeof b.output_link_1 === "string" ? b.output_link_1 : null;
  const outputDescription =
    typeof b.output_description === "string" ? b.output_description : null;

  try {
    const data =
      action === "open"
        ? await openCompetencyHub({
            organization: orgRaw,
            outputLink1,
            description: outputDescription,
            adminId: admin.userId,
          })
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
