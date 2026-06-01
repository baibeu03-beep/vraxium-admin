import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  CLUSTER4_LINE_WRITE_ROLES,
} from "@/lib/adminCluster4LinesTypes";
import {
  Cluster4LineError,
  listCluster4InfoLinesDetailed,
} from "@/lib/adminCluster4LinesData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isUuid } from "@/lib/isUuid";
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
import { describeOpenableWeek } from "@/lib/cluster4WeekPolicy";
import { resolveWeekOfficialRest } from "@/lib/officialRestPeriodsData";

// GET /api/admin/cluster4/info-lines?week_id=&activity_type_id=
// 실무 정보(part_type='info') 라인을 활동 유형 탭별/주차별로 운영하기 위한
// enriched 목록. 대상자 이름·제출 상태·lineTargetId 단위 canEdit 까지 포함한다.
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const weekId = params.get("week_id")?.trim() || null;
  const activityTypeId = params.get("activity_type_id")?.trim() || null;

  if (weekId !== null && !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const data = await listCluster4InfoLinesDetailed({ weekId, activityTypeId });
    return Response.json({ success: true, data });
  } catch (error) {
    if (error instanceof Cluster4LineError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/cluster4/info-lines GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list info lines",
      },
      { status: 500 },
    );
  }
}

type InfoLineCreateBody = {
  activity_type_id: string;
  main_title: string;
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

  // info_subtitle / info_growth_point 는 크루원 제출값으로 재정의됨 → 라인 개설 입력에서 제거.
  //   (cluster4_line_submissions.subtitle / growth_point 로 이전. 2026-05-30)

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
  // 레거시 컬럼은 항상 output_links 로부터 mirror.
  const [mirrorLink1, mirrorLink2] = outputLinksToLegacySlots(outputLinks, 2);
  outputLink1 = mirrorLink1;
  outputLink2 = mirrorLink2;

  // Output Asset validation: 1 <= total <= 2
  const linkCount = outputLinks.length;
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

  // ── 주차 정책 강제 (N-1) ──────────────────────────────────────────────
  // 운영 정책: 개설 가능 주차 = 현재 주차 N 의 직전 주차 N-1.
  // 일반(운영) 모드에서는 클라이언트가 보낸 week_id / 기입기간을 신뢰하지 않고
  // 서버가 계산한 N-1 주차로 강제한다 → payload 를 조작해도 임의 주차 개설 불가.
  // dev 모드(?dev=true)에서만 클라이언트가 지정한 과거 주차를 그대로 허용한다(테스트용).
  //   * dev 플래그는 표시 토글(useAdminDevMode)이며 보안 경계가 아니다. 목적은
  //     "일반 사용 경로에서의 임의 주차 개설 차단" 이다.
  const devMode = request.nextUrl.searchParams.get("dev") === "true";
  let effectiveWeekId = input.week_id;
  let effectiveOpensAt = input.submission_opens_at;
  let effectiveClosesAt = input.submission_closes_at;

  if (!devMode) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const openable = describeOpenableWeek(todayIso);
    if (!openable) {
      return Response.json(
        { success: false, error: "개설 가능 주차(N-1)를 계산할 수 없습니다" },
        { status: 500 },
      );
    }
    // 공식 휴식 = seasonCalendar rule(시험기간) ∨ official_rest_periods overlap(설/추석/임시).
    // weeks.is_official_rest 는 참조하지 않는다.
    const openableRest = await resolveWeekOfficialRest({
      startDate: openable.weekStart,
      endDate: openable.weekEnd,
    });
    if (
      openableRest.isOfficialRest ||
      !openable.submissionOpensAt ||
      !openable.submissionClosesAt
    ) {
      return Response.json(
        { success: false, error: "현재 개설 가능 주차(N-1)가 공식 휴식 주차입니다" },
        { status: 409 },
      );
    }
    const { data: openableRow, error: openableErr } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("iso_year", openable.isoYear)
      .eq("iso_week", openable.isoWeek)
      .maybeSingle();
    if (openableErr) {
      return Response.json(
        { success: false, error: openableErr.message },
        { status: 500 },
      );
    }
    if (!openableRow) {
      return Response.json(
        { success: false, error: "개설 가능 주차(N-1)에 해당하는 weeks 행이 없습니다" },
        { status: 409 },
      );
    }
    // 서버 계산값으로 덮어쓴다 — 클라이언트 입력은 무시.
    effectiveWeekId = openableRow.id;
    effectiveOpensAt = openable.submissionOpensAt;
    effectiveClosesAt = openable.submissionClosesAt;
  }

  try {
    // 1. Verify week exists
    const { data: weekRow, error: weekError } = await supabaseAdmin
      .from("weeks")
      .select("id")
      .eq("id", effectiveWeekId)
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

    // 3. Check for active line with same activity_type_id IN THE SAME WEEK.
    //    중복 기준: activity_type_id + week_id + is_active.
    //    cluster4_lines 에는 week_id 가 없고 cluster4_line_targets 에 있으므로,
    //    같은 활동 유형의 active 라인 중 "선택 주차에 target 이 있는" 라인이 있으면 중복.
    const { data: activeLines, error: activeLinesError } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "info")
      .eq("activity_type_id", input.activity_type_id)
      .eq("is_active", true);
    if (activeLinesError) {
      return Response.json(
        { success: false, error: activeLinesError.message },
        { status: 500 },
      );
    }
    const activeLineIds = (activeLines ?? []).map((l) => l.id);
    if (activeLineIds.length > 0) {
      const { data: clashTargets, error: clashError } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("id")
        .eq("week_id", effectiveWeekId)
        .in("line_id", activeLineIds)
        .limit(1);
      if (clashError) {
        return Response.json(
          { success: false, error: clashError.message },
          { status: 500 },
        );
      }
      if (clashTargets && clashTargets.length > 0) {
        return Response.json(
          {
            success: false,
            error: "선택한 주차에는 이 활동 유형의 활성 라인이 이미 있습니다",
          },
          { status: 409 },
        );
      }
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
        output_links: input.output_links,
        // output_images = [{url, caption}] (캡션 포함). 레거시 string[] 입력도 파서가 변환.
        output_images: input.output_images,
        submission_opens_at: effectiveOpensAt,
        submission_closes_at: effectiveClosesAt,
        is_active: true,
        created_by: admin.userId,
        updated_by: admin.userId,
      })
      .select("id,part_type,activity_type_id,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at")
      .single();

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }

    // 5. Bulk-create cluster4_line_targets
    const targetRows = input.target_user_ids.map((userId) => ({
      line_id: lineRow.id,
      week_id: effectiveWeekId,
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

    // 대상자 weekly-cards snapshot 즉시 재계산 → 고객 앱에 실제 라인이 바로 내려오게 한다.
    // (cron 축소로 stale-only 는 미반영) ≤10명 즉시 / >10명 백그라운드. best-effort.
    await invalidateWeeklyCardsForUsers(input.target_user_ids);

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
