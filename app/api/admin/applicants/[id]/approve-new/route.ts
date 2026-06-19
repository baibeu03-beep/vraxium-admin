// app/api/admin/applicants/[id]/approve-new/route.ts
import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  ApplicantApprovalError,
  autoApproveApplicant,
} from "@/lib/adminApplicantData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { id: applicantId } = await params;
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const result = await autoApproveApplicant(applicantId, mode);
    return NextResponse.json({
      ok: true,
      approval_kind: result.approvalKind,
      linked_user_id: result.linkedUserId,
    });
  } catch (error) {
    if (error instanceof ApplicantApprovalError) {
      const body =
        error.step !== undefined
          ? { step: error.step, error: error.message, details: error.details }
          : { error: error.message };
      return NextResponse.json(body, { status: error.status });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to approve applicant",
      },
      { status: (error as { status?: number })?.status ?? 400 },
    );
  }
}
