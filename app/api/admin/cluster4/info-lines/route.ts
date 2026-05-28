import { NextRequest } from "next/server";
import {
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  CLUSTER4_LINE_WRITE_ROLES,
} from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";

type InfoLineCreateBody = {
  activity_type_id: string;
  main_title: string;
  output_link_1: string | null;
  output_link_2: string | null;
  output_images: string[];
  target_user_ids: string[];
  week_id: string;
  submission_opens_at: string;
  submission_closes_at: string;
};

function parseBody(
  body: unknown,
): { ok: true; value: InfoLineCreateBody } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  // activity_type_id — required
  if (typeof b.activity_type_id !== "string" || b.activity_type_id.trim().length === 0) {
    return { ok: false, status: 400, error: "activity_type_id is required" };
  }

  // main_title — required
  if (typeof b.main_title !== "string" || b.main_title.trim().length === 0) {
    return { ok: false, status: 400, error: "main_title is required" };
  }

  // output_link_1 — optional
  let outputLink1: string | null = null;
  if (b.output_link_1 !== undefined && b.output_link_1 !== null) {
    if (typeof b.output_link_1 !== "string") {
      return { ok: false, status: 400, error: "output_link_1 must be a string or null" };
    }
    const trimmed = b.output_link_1.trim();
    outputLink1 = trimmed.length > 0 ? trimmed : null;
  }

  // output_link_2 — optional
  let outputLink2: string | null = null;
  if (b.output_link_2 !== undefined && b.output_link_2 !== null) {
    if (typeof b.output_link_2 !== "string") {
      return { ok: false, status: 400, error: "output_link_2 must be a string or null" };
    }
    const trimmed = b.output_link_2.trim();
    outputLink2 = trimmed.length > 0 ? trimmed : null;
  }

  // output_images — optional array
  let outputImages: string[] = [];
  if (b.output_images !== undefined && b.output_images !== null) {
    if (!Array.isArray(b.output_images)) {
      return { ok: false, status: 400, error: "output_images must be an array" };
    }
    for (const item of b.output_images) {
      if (typeof item !== "string") {
        return { ok: false, status: 400, error: "output_images items must be strings" };
      }
      const trimmed = item.trim();
      if (trimmed.length > 0) outputImages.push(trimmed);
    }
  }

  // Output Asset validation: 1 <= total <= 2
  const linkCount = (outputLink1 ? 1 : 0) + (outputLink2 ? 1 : 0);
  const imageCount = outputImages.length;
  const totalAssets = linkCount + imageCount;
  if (totalAssets < 1) {
    return { ok: false, status: 400, error: "Output을 최소 1개 입력해주세요 (Link + Image 합산)" };
  }
  if (totalAssets > 2) {
    return { ok: false, status: 400, error: "Output은 최대 2개까지 입력 가능합니다 (Link + Image 합산)" };
  }

  // target_user_ids — required, min 1
  if (!Array.isArray(b.target_user_ids) || b.target_user_ids.length === 0) {
    return { ok: false, status: 400, error: "개설 대상을 최소 1명 이상 선택해주세요" };
  }
  const targetUserIds: string[] = [];
  for (const uid of b.target_user_ids) {
    if (typeof uid !== "string" || !isUuid(uid)) {
      return { ok: false, status: 400, error: "target_user_ids must contain valid UUIDs" };
    }
    targetUserIds.push(uid);
  }

  // week_id — required
  if (typeof b.week_id !== "string" || !isUuid(b.week_id)) {
    return { ok: false, status: 400, error: "week_id is required and must be a UUID" };
  }

  // submission period — required (server-calculated, passed from client)
  if (typeof b.submission_opens_at !== "string") {
    return { ok: false, status: 400, error: "submission_opens_at is required" };
  }
  if (typeof b.submission_closes_at !== "string") {
    return { ok: false, status: 400, error: "submission_closes_at is required" };
  }

  return {
    ok: true,
    value: {
      activity_type_id: b.activity_type_id.trim(),
      main_title: b.main_title.trim(),
      output_link_1: outputLink1,
      output_link_2: outputLink2,
      output_images: outputImages,
      target_user_ids: targetUserIds,
      week_id: b.week_id,
      submission_opens_at: b.submission_opens_at,
      submission_closes_at: b.submission_closes_at,
    },
  };
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Diagnostic: raw body inspection — request payload 가 실제로 어떤 키를 가지는지 확인.
  console.log("[info-lines POST raw body]", body);

  const parsed = parseBody(body);
  if (!parsed.ok) {
    console.log("[info-lines POST parse failed]", parsed.error);
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  const input = parsed.value;

  try {
    // 1. Verify week exists
    const { data: weekRow, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("id", input.week_id)
      .maybeSingle();
    if (weekError) {
      return Response.json(
        { success: false, error: weekError.message },
        { status: 500 },
      );
    }
    if (!weekRow) {
      return Response.json(
        { success: false, error: "week not found" },
        { status: 404 },
      );
    }

    // 2. Verify activity_type exists in practical_info cluster
    const { data: actType, error: actError } = await supabaseAdmin
      .from("activity_types")
      .select("id")
      .eq("id", input.activity_type_id)
      .eq("cluster_id", "practical_info")
      .eq("is_active", true)
      .maybeSingle();
    if (actError) {
      return Response.json(
        { success: false, error: actError.message },
        { status: 500 },
      );
    }
    if (!actType) {
      return Response.json(
        { success: false, error: "해당 활동 유형을 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    // 3. Check for active line with same activity_type_id
    const { data: existingLine } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("activity_type_id", input.activity_type_id)
      .eq("is_active", true)
      .maybeSingle();
    if (existingLine) {
      return Response.json(
        { success: false, error: "해당 활동 유형에 이미 활성 라인이 존재합니다" },
        { status: 409 },
      );
    }

    // 4. Create cluster4_lines row
    const { data: lineRow, error: lineError } = await supabaseAdmin
      .from("cluster4_lines")
      .insert({
        part_type: "info",
        activity_type_id: input.activity_type_id,
        main_title: input.main_title,
        output_link_1: input.output_link_1,
        output_link_2: input.output_link_2,
        output_images: input.output_images,
        submission_opens_at: input.submission_opens_at,
        submission_closes_at: input.submission_closes_at,
        is_active: true,
        created_by: admin.userId,
        updated_by: admin.userId,
      })
      .select("id,part_type,activity_type_id,main_title,output_link_1,output_link_2,output_images,submission_opens_at,submission_closes_at,is_active,created_at")
      .single();

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }

    // 5. Bulk-create cluster4_line_targets
    const targetRows = input.target_user_ids.map((userId) => ({
      line_id: lineRow.id,
      week_id: input.week_id,
      target_mode: "user" as const,
      target_user_id: userId,
      target_rule: {},
      created_by: admin.userId,
      updated_by: admin.userId,
    }));

    const { data: targets, error: targetError } = await supabaseAdmin
      .from("cluster4_line_targets")
      .insert(targetRows)
      .select("id,line_id,week_id,target_user_id");

    if (targetError) {
      // Line was created but targets failed — still report partial success
      console.error("[admin/cluster4/info-lines POST] targets insert failed", targetError);
      return Response.json(
        {
          success: false,
          error: `라인은 생성되었으나 대상 등록에 실패했습니다: ${targetError.message}`,
          data: { lineId: lineRow.id },
        },
        { status: 500 },
      );
    }

    return Response.json(
      {
        success: true,
        data: {
          line: lineRow,
          targets: targets ?? [],
          targetCount: input.target_user_ids.length,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[admin/cluster4/info-lines POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create info line",
      },
      { status: 500 },
    );
  }
}
