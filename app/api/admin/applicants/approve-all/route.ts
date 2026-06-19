// app/api/admin/applicants/approve-all/route.ts
// 전체 승인 — 현재 mode 스코프의 pending 지원자 전원을 단건 승인과 동일한 경로
//   (autoApproveApplicant) 로 순차 처리한다. 일부 실패해도 전체를 중단하지 않고
//   per-applicant 결과를 반환하며, 이미 승인/거절된 지원자는 모집단에서 제외된다(멱등).
import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { approveAllPendingApplicants } from "@/lib/adminApplicantData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const summary = await approveAllPendingApplicants(mode);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error("[admin/applicants approve-all]", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to bulk-approve applicants",
      },
      { status: (error as { status?: number })?.status ?? 500 },
    );
  }
}
