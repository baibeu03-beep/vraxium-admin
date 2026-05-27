import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import {
  Cluster4PublicLineError,
  createCluster4LineSubmissionForAuthUser,
  updateCluster4LineSubmissionForAuthUser,
} from "@/lib/cluster4LinesData";
import { parseCluster4LineSubmissionBody } from "@/lib/cluster4LinesTypes";

type Ctx = { params: Promise<{ lineTargetId: string }> };

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
  let user;
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
    const submission = await createCluster4LineSubmissionForAuthUser(
      user.id,
      user.email ?? null,
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
  let user;
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
    const submission = await updateCluster4LineSubmissionForAuthUser(
      user.id,
      user.email ?? null,
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
