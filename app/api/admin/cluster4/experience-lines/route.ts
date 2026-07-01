import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import { assertUserIdsInScope, resolveUserScope, readScopeMode } from "@/lib/userScope";
import { invalidateWeeklyCardsForLineOpen } from "@/lib/adminCluster4LinesData";
import { getRegistrationByBridgedMasterId } from "@/lib/lineRegistrationLookup";
import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  outputLinksToLegacySlots,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";
import {
  type Cluster4OutputImage,
  parseOutputImagesInput,
} from "@/lib/cluster4OutputImages";

type ExperienceLineCreateBody = {
  experience_line_master_id: string;
  line_code: string;
  main_title: string;
  team_id: string | null;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: Cluster4OutputLink[];
  output_images: Cluster4OutputImage[];
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

  // output_images — optional. string[] 또는 [{url, caption?}] 둘 다 허용 (URL + 캡션 저장).
  const parsedImages = parseOutputImagesInput(b.output_images);
  if (!parsedImages.ok) {
    return { ok: false, status: 400, error: parsedImages.error };
  }
  const outputImages = parsedImages.value;

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

  // ── 조직 + 운영/테스트 스코프 강제 (cluster4_line_targets 혼입 방지) ─────────
  //   info-lines/competency-lines POST 와 동일 가드. 개설 대상(target_user_ids)은 (현재 org 소속)
  //   AND (현재 mode 모집단) 둘 다여야 한다. operating=실사용자만 / test=test_user_markers 만.
  //   org 지정(?organization) 시 전원 그 org 소속이어야(동명이인 타org 차단). 위반 시 DB write 0.
  const scopeOrgRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  const scopeOrg = isOrganizationSlug(scopeOrgRaw) ? scopeOrgRaw : null;
  const scopeMode = readScopeMode(request.nextUrl.searchParams);

  // 1) 개설 대상(target_user_ids)은 현재 모집단에 부합해야 한다 — 다른 라인개설 경로(info/competency)와
  //    동일하게 QA_HIDE_REAL_USERS 기준 population 게이트를 쓴다. QA 기간엔 화면에 보인 test 크루 ==
  //    개설 대상(test 유저)로 통일되고, 운영 복귀 후엔 실사용자로 통일된다.
  try {
    const scope = await resolveUserScope(scopeMode, scopeOrg);
    assertUserIdsInScope(scope, input.target_user_ids);
  } catch (error) {
    if ((error as { status?: number })?.status === 422) {
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 422 },
      );
    }
    throw error;
  }

  // 2) org 가드 — org-scoped 개설은 target 전원이 그 org 소속이어야 한다(동명이인 타org 저장 차단).
  if (scopeOrg && input.target_user_ids.length > 0) {
    const { data: orgRows, error: orgErr } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", input.target_user_ids);
    if (orgErr) {
      return Response.json({ success: false, error: orgErr.message }, { status: 500 });
    }
    const orgById = new Map(
      ((orgRows ?? []) as Array<{ user_id: string; organization_slug: string | null }>).map(
        (r) => [r.user_id, r.organization_slug],
      ),
    );
    const orgOffenders = input.target_user_ids.filter(
      (id) => orgById.get(id) !== scopeOrg,
    );
    if (orgOffenders.length > 0) {
      return Response.json(
        {
          success: false,
          error: `현재 조직(${scopeOrg}) 소속이 아닌 사용자 ${orgOffenders.length}명이 포함되어 처리를 중단했습니다.`,
        },
        { status: 422 },
      );
    }
  }

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

    // (2E-3) 개설 검증: line_registrations(bridged 역참조) 우선 — 연결 registration 이 있으면
    // 그 is_active 로 판정하고, 미연결이면 기존 마스터 검증으로 fallback (운영 중단 방지).
    // cluster4_lines 에는 기존대로 master FK(input.experience_line_master_id)를 기록한다.
    const reg = await getRegistrationByBridgedMasterId(input.experience_line_master_id);
    if (reg) {
      if (!reg.isActive) {
        return Response.json(
          { success: false, error: "해당 라인을 찾을 수 없습니다" },
          { status: 404 },
        );
      }
    } else {
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

    // weekly-cards snapshot 무효화 = 3허브 통일 헬퍼(info/competency 와 동일 기준):
    //   배정 타깃(즉시 재계산 → 개설 크루 바로 반영) + org audience 분모 A(stale→lazy 수렴).
    //   스코프는 헬퍼가 mode 로 적용(교차 모드 실유저 무접촉 — 과거 experience 는 스코프 미적용이었음).
    await invalidateWeeklyCardsForLineOpen(lineRow.id, input.target_user_ids, scopeMode);

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
