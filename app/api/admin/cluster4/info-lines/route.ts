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
  collectLineOrgAudience,
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
import { isOrganizationSlug } from "@/lib/organizations";
import { insertOpeningLogForLine } from "@/lib/adminCluster4OpeningLogs";

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
  // 조직 스코프(통합 ↔ 조직 진입). 내부 API 컨벤션은 organization. 미지정/무효 = 통합(전체).
  const organizationRaw = params.get("organization")?.trim() || null;
  const organization = isOrganizationSlug(organizationRaw) ? organizationRaw : null;

  if (weekId !== null && !isUuid(weekId)) {
    return Response.json(
      { success: false, error: "week_id must be a UUID" },
      { status: 400 },
    );
  }

  try {
    const data = await listCluster4InfoLinesDetailed({
      weekId,
      activityTypeId,
      organization,
    });
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
  // 라인 개설 크루(targetCrewIds). 0명 허용 — 0명 개설 = 전체 크루 강화 실패.
  target_user_ids: string[];
  week_id: string;
  submission_opens_at: string;
  submission_closes_at: string;
  // 카페 검수 메타(선택, 감사용). 컬럼 미존재 시 저장 생략.
  cafe_url: string | null;
  matched_crew_count: number | null;
  raw_comment_count: number | null;
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

  // 라인 개설 크루 — target_user_ids(= targetCrewIds). 0명 허용(2026-06-09 정책 개정).
  //   0명 개설 = "라인은 개설됐지만 성공 대상자 0명" → 그 주차/라인은 전체 크루에게 강화 실패.
  //   (라인 자체가 없으면 기존처럼 해당 없음.) 배열이기만 하면 되고, 항목은 유효 UUID 여야 한다.
  const rawTargets = Array.isArray(b.target_user_ids)
    ? b.target_user_ids
    : Array.isArray(b.target_crew_ids)
      ? b.target_crew_ids
      : null;
  if (rawTargets === null) {
    return { ok: false, status: 400, error: "target_user_ids must be an array (0명 허용)" };
  }
  const targetUserIds: string[] = [];
  for (const uid of rawTargets) {
    if (typeof uid !== "string" || !isUuid(uid)) {
      return { ok: false, status: 400, error: "target_user_ids must contain valid UUIDs" };
    }
    targetUserIds.push(uid);
  }
  // 중복 제거(같은 크루 중복 선택 방지).
  const dedupedTargetIds = Array.from(new Set(targetUserIds));

  // 카페 검수 메타(선택) — 문자열/숫자 또는 null.
  let cafeUrl: string | null = null;
  if (typeof b.cafe_url === "string" && b.cafe_url.trim().length > 0) {
    cafeUrl = b.cafe_url.trim();
  }
  const toIntOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
  const matchedCrewCount = toIntOrNull(b.matched_crew_count);
  const rawCommentCount = toIntOrNull(b.raw_comment_count);

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
      target_user_ids: dedupedTargetIds,
      week_id: b.week_id,
      submission_opens_at: b.submission_opens_at,
      submission_closes_at: b.submission_closes_at,
      cafe_url: cafeUrl,
      matched_crew_count: matchedCrewCount,
      raw_comment_count: rawCommentCount,
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

  // ── 주차 정책 강제 (목요일 경계 규칙) ─────────────────────────────────
  // 운영 정책: 개설 가능 주차 = describeOpenableWeek(목요일 경계). 월·화·수=N-1,
  //   목·금·토·일=N(현재 주). weeks-options.isOpenTarget 과 동일 함수를 공유하므로
  //   프론트 표시 주차 == 서버 저장 주차.
  // 일반(운영) 모드에서는 클라이언트가 보낸 week_id / 기입기간을 신뢰하지 않고
  // 서버가 계산한 개설 대상 주차로 강제한다 → payload 를 조작해도 임의 주차 개설 불가.
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

    // 4. Create cluster4_lines row.
    //    week_id 를 라인 자체에도 기록(0명 개설 포함) — 어드민 주차/이력 정합. (기존엔 NULL)
    //    cafe_* 메타는 선택 — 컬럼 미적용(42703)이면 메타 없이 재시도(graceful).
    const LINE_RETURN =
      "id,part_type,activity_type_id,week_id,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at";
    const baseLinePayload = {
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
      week_id: effectiveWeekId,
      is_active: true,
      created_by: admin.userId,
      updated_by: admin.userId,
    };
    const cafePayload = {
      cafe_url: input.cafe_url,
      matched_crew_count: input.matched_crew_count,
      raw_comment_count: input.raw_comment_count,
    };

    type LineRow = { id: string; [key: string]: unknown };
    let lineRow: LineRow | null = null;
    let lineError: { message?: string; code?: string } | null = null;
    {
      const res = await supabaseAdmin
        .from("cluster4_lines")
        .insert({ ...baseLinePayload, ...cafePayload })
        .select(LINE_RETURN)
        .single();
      lineRow = (res.data as LineRow | null) ?? null;
      lineError = res.error;
      // cafe_* 컬럼 미적용 감지 — undefined_column(42703) 또는 PostgREST 스키마 캐시 미존재(PGRST204)
      // 또는 메시지에 cafe 컬럼/schema cache 언급. 어느 쪽이든 메타 없이 재시도한다.
      const missingCafeCol =
        !!lineError &&
        (lineError.code === "42703" ||
          lineError.code === "PGRST204" ||
          /cafe_url|matched_crew_count|raw_comment_count|schema cache/i.test(
            lineError.message ?? "",
          ));
      if (missingCafeCol) {
        // cafe_* 컬럼 미적용 — 메타 없이 재시도.
        const retry = await supabaseAdmin
          .from("cluster4_lines")
          .insert(baseLinePayload)
          .select(LINE_RETURN)
          .single();
        lineRow = (retry.data as LineRow | null) ?? null;
        lineError = retry.error;
      }
    }

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }
    const createdLine: LineRow = lineRow;

    // 5. Create cluster4_line_targets.
    //    - 크루 1명 이상: user-mode 타깃(기존). 그 크루만 강화 대기→성공 흐름, 미배정 크루는 강화 실패.
    //    - 크루 0명: "라인은 개설, 성공 대상자 0명". 주차-라인 연결을 위해 sentinel(rule-mode,
    //      user=null, target_rule.zeroTargetOpen=true) 1행만 넣는다. 스냅샷 openedByWeek 가 이 행으로
    //      라인을 그 주차에 "개설됨"으로 인식 → 전체 크루가 강화 실패(누구도 user-target 아님).
    //      이 sentinel 은 어드민 대상자 목록/카운트에서 제외된다(listCluster4LinesDetailed 필터).
    type TargetInsert = {
      line_id: string;
      week_id: string;
      target_mode: "user" | "rule";
      target_user_id: string | null;
      target_rule: Record<string, unknown>;
      created_by: string;
      updated_by: string;
    };
    const isZeroTarget = input.target_user_ids.length === 0;
    const targetRows: TargetInsert[] = isZeroTarget
      ? [
          {
            line_id: createdLine.id,
            week_id: effectiveWeekId,
            target_mode: "rule",
            target_user_id: null,
            target_rule: { zeroTargetOpen: true },
            created_by: admin.userId,
            updated_by: admin.userId,
          },
        ]
      : input.target_user_ids.map((userId) => ({
          line_id: createdLine.id,
          week_id: effectiveWeekId,
          target_mode: "user",
          target_user_id: userId,
          target_rule: {},
          created_by: admin.userId,
          updated_by: admin.userId,
        }));

    const { data: targets, error: targetError } = await supabaseAdmin
      .from("cluster4_line_targets")
      .insert(targetRows)
      .select("id,line_id,week_id,target_user_id,target_mode");

    if (targetError) {
      // Line was created but targets failed — still report partial success
      console.error("[admin/cluster4/info-lines POST] targets insert failed", targetError);
      return Response.json(
        {
          success: false,
          error: `라인은 생성되었으나 대상 등록에 실패했습니다: ${targetError.message}`,
          data: { lineId: createdLine.id },
        },
        { status: 500 },
      );
    }

    // weekly-cards snapshot 무효화 → 고객 앱 반영.
    //   - 크루 1명 이상: 배정 크루(기존 동작). (미배정 크루의 fail 은 lazy/배치로 수렴 — 기존과 동일)
    //   - 크루 0명: 배정 크루가 없으므로, 라인 노출 org audience(전체 크루) 를 무효화해 "전체 강화 실패"가
    //     반영되게 한다. ≤10명 즉시 / >10명 stale+백그라운드. best-effort.
    if (isZeroTarget) {
      const audience = await collectLineOrgAudience(createdLine.id);
      await invalidateWeeklyCardsForUsers(audience);
    } else {
      await invalidateWeeklyCardsForUsers(input.target_user_ids);
    }

    // [섹션 0] 로그창: 개설 = [개설 완료] 로그. best-effort(snapshot 무관, 본 동작과 분리).
    await insertOpeningLogForLine({
      action: "open",
      lineId: createdLine.id,
      weekId: effectiveWeekId,
      activityTypeId: input.activity_type_id,
      changedBy: admin.userId,
    });

    return Response.json(
      {
        success: true,
        data: {
          line: createdLine,
          // sentinel(rule) 행은 노출하지 않는다 — 실제 user 타깃만.
          targets: (targets ?? []).filter(
            (t) => (t as { target_mode?: string }).target_mode === "user",
          ),
          targetCount: input.target_user_ids.length,
          matchedCrewCount: input.matched_crew_count,
          rawCommentCount: input.raw_comment_count,
          cafeUrl: input.cafe_url,
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
