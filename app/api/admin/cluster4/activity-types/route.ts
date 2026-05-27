import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const VALID_CLUSTERS = [
  "practical_info",
  "practical_competency",
  "practical_experience",
  "practical_career",
] as const;

type ActivityTypeRow = {
  id: string;
  name: string;
  line_code: string | null;
  description: string | null;
  is_active: boolean;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const cluster = request.nextUrl.searchParams.get("cluster")?.trim();

  if (!cluster || !(VALID_CLUSTERS as readonly string[]).includes(cluster)) {
    return Response.json(
      {
        success: false,
        error: `cluster must be one of ${VALID_CLUSTERS.join("|")}`,
      },
      { status: 400 },
    );
  }

  try {
    const { data: types, error } = await supabaseAdmin
      .from("activity_types")
      .select("id,name,line_code,description,is_active")
      .eq("cluster_id", cluster)
      .eq("is_active", true)
      .order("id", { ascending: true });

    if (error) {
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }

    // Check which activity_type_ids already have an active line
    const typeIds = ((types ?? []) as ActivityTypeRow[]).map((t) => t.id);
    let activeLineTypeIds = new Set<string>();

    if (typeIds.length > 0) {
      const { data: activeLines } = await supabaseAdmin
        .from("cluster4_lines")
        .select("activity_type_id")
        .eq("is_active", true)
        .in("activity_type_id", typeIds);

      if (activeLines) {
        activeLineTypeIds = new Set(
          (activeLines as Array<{ activity_type_id: string | null }>)
            .map((l) => l.activity_type_id)
            .filter((id): id is string => id != null),
        );
      }
    }

    const result = ((types ?? []) as ActivityTypeRow[]).map((t) => ({
      id: t.id,
      name: t.name,
      lineCode: t.line_code,
      description: t.description,
      isActive: Boolean(t.is_active),
      hasActiveLine: activeLineTypeIds.has(t.id),
    }));

    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[admin/cluster4/activity-types GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to list activity types",
      },
      { status: 500 },
    );
  }
}
