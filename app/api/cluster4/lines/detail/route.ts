import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  Cluster4PublicLineError,
  getCluster4LineDetailForAuthUser,
} from "@/lib/cluster4LinesData";

function isPartType(value: string | null): value is "info" | "experience" | "competency" | "career" {
  return (
    value === "info" ||
    value === "experience" ||
    value === "competency" ||
    value === "career"
  );
}

export async function GET(request: NextRequest) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json(
      { success: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const weekId = request.nextUrl.searchParams.get("weekId")?.trim() || null;
  const partType = request.nextUrl.searchParams.get("partType")?.trim() || null;

  if (!weekId) {
    return Response.json(
      { success: false, error: "weekId is required." },
      { status: 400 },
    );
  }
  if (!isPartType(partType)) {
    return Response.json(
      { success: false, error: "partType must be one of info|experience|competency|career." },
      { status: 400 },
    );
  }

  try {
    const data = await getCluster4LineDetailForAuthUser(
      user.id,
      user.email ?? null,
      weekId,
      partType,
    );
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof Cluster4PublicLineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[cluster4/lines/detail GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load line detail.",
      },
      { status: 500 },
    );
  }
}
