import { NextRequest } from "next/server";
import {
  getResumeCardForCrew,
  patchResumeCardForCrew,
  ResumeCardError,
  type ResumeCardPatchBody,
} from "@/lib/adminResumeCardData";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  const { legacy_user_id } = await params;
  try {
    const bundle = await getResumeCardForCrew(legacy_user_id);
    if (!bundle) {
      return Response.json(
        { success: false, error: "Crew not found" },
        { status: 404 },
      );
    }
    return Response.json({ success: true, data: bundle });
  } catch (error) {
    console.error("[admin/crews/:legacy_user_id/resume-card GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load resume-card",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { legacy_user_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  try {
    const { bundle, warnings, applied } = await patchResumeCardForCrew(
      legacy_user_id,
      body as ResumeCardPatchBody,
    );
    return Response.json({
      success: true,
      data: bundle,
      warnings: warnings.length > 0 ? warnings : undefined,
      applied,
    });
  } catch (error) {
    console.error("[admin/crews/:legacy_user_id/resume-card PATCH]", error);
    if (error instanceof ResumeCardError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to update resume-card",
      },
      { status: 500 },
    );
  }
}
