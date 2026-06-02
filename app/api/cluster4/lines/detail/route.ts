import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  Cluster4PublicLineError,
  getCluster4LineDetailForAuthUser,
  getCluster4LineDetailForProfileUser,
} from "@/lib/cluster4LinesData";
import { DemoModeError, resolveDemoProfileUserId } from "@/lib/demoMode";

function isPartType(value: string | null): value is "info" | "experience" | "competency" | "career" {
  return (
    value === "info" ||
    value === "experience" ||
    value === "competency" ||
    value === "career"
  );
}

export async function GET(request: NextRequest) {
  // 데모 모드: demoUserId 가 유효한 테스트 유저면 세션 인증을 건너뛴다.
  let demoProfileUserId: string | null = null;
  try {
    demoProfileUserId = await resolveDemoProfileUserId(request);
  } catch (error) {
    if (error instanceof DemoModeError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    throw error;
  }

  let sessionUser: { id: string; email: string | null | undefined } | null =
    null;
  if (!demoProfileUserId) {
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
    sessionUser = { id: user.id, email: user.email };
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

  // 데모 인증은 demoUserId(viewer)로 통과하되, 조회 대상은 userId(pageOwner)가 있으면 우선한다.
  // foreign viewer(테스트유저가 타 유저 페이지 조회) 시 라인 상세는 페이지 주인 기준이어야 함.
  const requestedUserId = request.nextUrl.searchParams.get("userId")?.trim() || null;

  try {
    const data = demoProfileUserId
      ? await getCluster4LineDetailForProfileUser(
          requestedUserId || demoProfileUserId,
          weekId,
          partType,
        )
      : await getCluster4LineDetailForAuthUser(
          sessionUser!.id,
          sessionUser!.email ?? null,
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
