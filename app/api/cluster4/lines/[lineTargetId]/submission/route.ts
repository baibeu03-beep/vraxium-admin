import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  Cluster4PublicLineError,
  createCluster4LineSubmissionForAuthUser,
  createCluster4LineSubmissionForProfileUser,
  updateCluster4LineSubmissionForAuthUser,
  updateCluster4LineSubmissionForProfileUser,
} from "@/lib/cluster4LinesData";
import { parseCluster4LineSubmissionBody } from "@/lib/cluster4LinesTypes";
import { DemoModeError, resolveDemoProfileUserId } from "@/lib/demoMode";

type Ctx = { params: Promise<{ lineTargetId: string }> };

// 데모 쓰기 주체 해소.
//   - demoUserId 없음 → null (일반 세션 인증 경로)
//   - 데모 모드 on + test_user_markers 등재 유저 → 그 profile.user_id (쓰기 허용)
//   - 데모 모드 on + 미등재(운영 일반) user_id → DemoModeError(403) (resolveDemoProfileUserId 내부)
//   - 데모 모드 off(운영 + ENABLE_DEMO_MODE 미설정) → null → 일반 세션 인증 경로
async function requireAuthenticatedUser() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    throw new Cluster4PublicLineError(401, "Authentication required.");
  }
  return user;
}

export async function POST(request: NextRequest, { params }: Ctx) {
  // 데모 쓰기 주체 해소 (test_user_markers 검증 + 운영 게이트는 resolveDemoProfileUserId 내부).
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

  let user;
  if (!demoProfileUserId) {
    try {
      user = await requireAuthenticatedUser();
    } catch (error) {
      if (error instanceof Cluster4PublicLineError) {
        return Response.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
  }

  const { lineTargetId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCluster4LineSubmissionBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const submission = demoProfileUserId
      ? await createCluster4LineSubmissionForProfileUser(
          demoProfileUserId,
          lineTargetId,
          parsed.value,
        )
      : await createCluster4LineSubmissionForAuthUser(
          user!.id,
          user!.email ?? null,
          lineTargetId,
          parsed.value,
        );
    return Response.json({ success: true, data: { submission } }, { status: 201 });
  } catch (error) {
    if (error instanceof Cluster4PublicLineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[cluster4/lines/:lineTargetId/submission POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create submission.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  // 데모 쓰기 주체 해소 (test_user_markers 검증 + 운영 게이트는 resolveDemoProfileUserId 내부).
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

  let user;
  if (!demoProfileUserId) {
    try {
      user = await requireAuthenticatedUser();
    } catch (error) {
      if (error instanceof Cluster4PublicLineError) {
        return Response.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
  }

  const { lineTargetId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const parsed = parseCluster4LineSubmissionBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  try {
    const submission = demoProfileUserId
      ? await updateCluster4LineSubmissionForProfileUser(
          demoProfileUserId,
          lineTargetId,
          parsed.value,
        )
      : await updateCluster4LineSubmissionForAuthUser(
          user!.id,
          user!.email ?? null,
          lineTargetId,
          parsed.value,
        );
    return Response.json({ success: true, data: { submission } });
  } catch (error) {
    if (error instanceof Cluster4PublicLineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[cluster4/lines/:lineTargetId/submission PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update submission.",
      },
      { status: 500 },
    );
  }
}
