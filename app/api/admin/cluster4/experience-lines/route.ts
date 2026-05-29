import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  outputLinksToLegacySlots,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";

type ExperienceLineCreateBody = {
  experience_line_master_id: string;
  line_code: string;
  main_title: string;
  team_id: string | null;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: Cluster4OutputLink[];
  output_images: string[];
  target_user_ids: string[];
  week_id: string;
  submission_opens_at: string;
  submission_closes_at: string;
};

function parseBody(
  body: unknown,
): { ok: true; value: ExperienceLineCreateBody } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.experience_line_master_id !== "string" || !isUuid(b.experience_line_master_id)) {
    return { ok: false, status: 400, error: "experience_line_master_id is required (UUID)" };
  }

  if (typeof b.line_code !== "string" || b.line_code.trim().length === 0) {
    return { ok: false, status: 400, error: "line_code is required" };
  }

  if (typeof b.main_title !== "string" || b.main_title.trim().length === 0) {
    return { ok: false, status: 400, error: "main_title is required" };
  }

  let teamId: string | null = null;
  if (b.team_id !== undefined && b.team_id !== null) {
    if (typeof b.team_id !== "string" || !isUuid(b.team_id)) {
      return { ok: false, status: 400, error: "team_id must be a UUID or null" };
    }
    teamId = b.team_id;
  }

  let outputLink1: string | null = null;
  if (b.output_link_1 !== undefined && b.output_link_1 !== null) {
    if (typeof b.output_link_1 !== "string") {
      return { ok: false, status: 400, error: "output_link_1 must be a string or null" };
    }
    const trimmed = b.output_link_1.trim();
    outputLink1 = trimmed.length > 0 ? trimmed : null;
  }

  let outputLink2: string | null = null;
  if (b.output_link_2 !== undefined && b.output_link_2 !== null) {
    if (typeof b.output_link_2 !== "string") {
      return { ok: false, status: 400, error: "output_link_2 must be a string or null" };
    }
    const trimmed = b.output_link_2.trim();
    outputLink2 = trimmed.length > 0 ? trimmed : null;
  }

  const outputImages: string[] = [];
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

  // output_links 우선. 미제공 시 레거시 output_link_1/2 로부터 파생. 라인은 슬롯 2개.
  const parsedLinks = parseOutputLinksInput(b.output_links, { maxLinks: 2 });
  if (!parsedLinks.ok) {
    return { ok: false, status: 400, error: parsedLinks.error };
  }
  const outputLinks =
    parsedLinks.value.length > 0
      ? parsedLinks.value
      : outputLinksFromLegacy([outputLink1, outputLink2]);
  const [mirrorLink1, mirrorLink2] = outputLinksToLegacySlots(outputLinks, 2);
  outputLink1 = mirrorLink1;
  outputLink2 = mirrorLink2;

  const linkCount = outputLinks.length;
  const totalAssets = linkCount + outputImages.length;
  if (totalAssets < 1) {
    return { ok: false, status: 400, error: "Output을 최소 1개 입력해주세요 (Link + Image 합산)" };
  }
  if (totalAssets > 2) {
    return { ok: false, status: 400, error: "Output은 최대 2개까지 입력 가능합니다 (Link + Image 합산)" };
  }

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

  if (typeof b.week_id !== "string" || !isUuid(b.week_id)) {
    return { ok: false, status: 400, error: "week_id is required and must be a UUID" };
  }

  if (typeof b.submission_opens_at !== "string") {
    return { ok: false, status: 400, error: "submission_opens_at is required" };
  }
  if (typeof b.submission_closes_at !== "string") {
    return { ok: false, status: 400, error: "submission_closes_at is required" };
  }

  return {
    ok: true,
    value: {
      experience_line_master_id: b.experience_line_master_id,
      line_code: b.line_code.trim(),
      main_title: b.main_title.trim(),
      team_id: teamId,
      output_link_1: outputLink1,
      output_link_2: outputLink2,
      output_links: outputLinks,
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

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return Response.json(
      { success: false, error: parsed.error },
      { status: parsed.status },
    );
  }

  const input = parsed.value;

  try {
    const { data: weekRow, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("id", input.week_id)
      .maybeSingle();
    if (weekError) {
      return Response.json({ success: false, error: weekError.message }, { status: 500 });
    }
    if (!weekRow) {
      return Response.json({ success: false, error: "week not found" }, { status: 404 });
    }

    const { data: master, error: masterError } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("id")
      .eq("id", input.experience_line_master_id)
      .eq("is_active", true)
      .maybeSingle();
    if (masterError) {
      return Response.json({ success: false, error: masterError.message }, { status: 500 });
    }
    if (!master) {
      return Response.json(
        { success: false, error: "해당 라인을 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    const { data: lineRow, error: lineError } = await supabaseAdmin
      .from("cluster4_lines")
      .insert({
        part_type: "experience",
        experience_line_master_id: input.experience_line_master_id,
        line_code: input.line_code,
        main_title: input.main_title,
        team_id: input.team_id,
        output_link_1: input.output_link_1,
        output_link_2: input.output_link_2,
        output_links: input.output_links,
        output_images: input.output_images,
        submission_opens_at: input.submission_opens_at,
        submission_closes_at: input.submission_closes_at,
        is_active: true,
        created_by: admin.userId,
        updated_by: admin.userId,
      })
      .select("id,part_type,line_code,experience_line_master_id,main_title,team_id,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at")
      .single();

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create experience line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }

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
      console.error("[experience-lines POST] targets insert failed", targetError);
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
    console.error("[experience-lines POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create experience line",
      },
      { status: 500 },
    );
  }
}
