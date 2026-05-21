import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  Cluster4Error,
  deleteCluster4Resource,
  getCluster4ForCrew,
  patchCluster4ForCrew,
} from "@/lib/adminCluster4Data";
import type {
  Cluster4DeleteResource,
  Cluster4PatchBody,
} from "@/lib/adminCluster4Types";

type Ctx = { params: Promise<{ legacy_user_id: string }> };

export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;

  try {
    const bundle = await getCluster4ForCrew(legacy_user_id);
    if (!bundle.userId) {
      console.warn(
        "[admin/crews/:id/cluster4 GET] user_profiles lookup failed for routeParam=",
        legacy_user_id,
      );
    }
    return Response.json({ success: true, data: bundle });
  } catch (error) {
    console.error("[admin/crews/:id/cluster4 GET]", error);
    if (error instanceof Cluster4Error) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load cluster4",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

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
    const { bundle, warnings, applied } = await patchCluster4ForCrew(
      legacy_user_id,
      body as Cluster4PatchBody,
    );
    return Response.json({
      success: true,
      data: bundle,
      warnings: warnings.length > 0 ? warnings : undefined,
      applied,
    });
  } catch (error) {
    console.error("[admin/crews/:id/cluster4 PATCH]", error);
    if (error instanceof Cluster4Error) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to update cluster4",
      },
      { status: 500 },
    );
  }
}

// DELETE 는 다음 query param 중 하나로 분기:
//   - seasonReputationId
//   - weeklyReputationId
//   - weeklyReviewId
//   - weeklyColleagueId
//   - userActivityDetailId  (Work Info / Work Ability / Work Exp)
//   - careerRecordId        (Work Career)
// 정확히 하나만 지정되어야 함.
const DELETE_PARAM_MAP: Array<{
  param: string;
  resource: Cluster4DeleteResource;
}> = [
  { param: "seasonReputationId", resource: "seasonReputation" },
  { param: "weeklyReputationId", resource: "weeklyReputation" },
  { param: "weeklyReviewId", resource: "weeklyReview" },
  { param: "weeklyColleagueId", resource: "weeklyColleague" },
  { param: "userActivityDetailId", resource: "userActivityDetail" },
  { param: "careerRecordId", resource: "careerRecord" },
];

export async function DELETE(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { legacy_user_id } = await params;
  const { searchParams } = new URL(request.url);

  const matches = DELETE_PARAM_MAP.map((spec) => {
    const value = searchParams.get(spec.param);
    return value && value.trim() !== ""
      ? { ...spec, value: value.trim() }
      : null;
  }).filter(
    (m): m is { param: string; resource: Cluster4DeleteResource; value: string } =>
      m !== null,
  );

  if (matches.length === 0) {
    return Response.json(
      {
        success: false,
        error:
          "Exactly one of seasonReputationId / weeklyReputationId / weeklyReviewId / weeklyColleagueId / userActivityDetailId / careerRecordId query parameters is required.",
      },
      { status: 400 },
    );
  }

  if (matches.length > 1) {
    return Response.json(
      {
        success: false,
        error: "Only one DELETE target query parameter is allowed at a time.",
      },
      { status: 400 },
    );
  }

  const { resource, value } = matches[0];

  try {
    const { bundle, deletedId } = await deleteCluster4Resource(
      legacy_user_id,
      resource,
      value,
    );
    return Response.json({
      success: true,
      data: bundle,
      deleted: { resource, id: deletedId },
    });
  } catch (error) {
    console.error("[admin/crews/:id/cluster4 DELETE]", error);
    if (error instanceof Cluster4Error) {
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
            : "Failed to delete cluster4 resource",
      },
      { status: 500 },
    );
  }
}
