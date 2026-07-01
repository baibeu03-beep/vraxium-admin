import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isUuid } from "@/lib/isUuid";
import { isOrganizationSlug } from "@/lib/organizations";
import {
  assertUserIdsInScope,
  readScopeMode,
  resolveUserScope,
} from "@/lib/userScope";
import { getRegistrationByBridgedMasterId } from "@/lib/lineRegistrationLookup";
import {
  getCurrentActivityDateIso,
  getSeasonForDate,
  getCalendarWeekStatus,
} from "@/lib/seasonCalendar";
import { resolveWeekOfficialRest } from "@/lib/officialRestPeriodsData";
import { hasActiveAllLineException } from "@/lib/lineOpeningWindowsData";
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

type CompetencyLineCreateBody = {
  competency_line_master_id: string;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: Cluster4OutputLink[];
  output_images: Cluster4OutputImage[];
  target_user_ids: string[];
  // 어드민/테스트 모드 override — 미지정 시 서버가 current week 로 폴백.
  week_id: string | null;
  submission_opens_at: string | null;
  submission_closes_at: string | null;
};

function parseBody(
  body: unknown,
): { ok: true; value: CompetencyLineCreateBody } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.competency_line_master_id !== "string" || !isUuid(b.competency_line_master_id)) {
    return { ok: false, status: 400, error: "competency_line_master_id is required (UUID)" };
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

  const totalAssets = outputLinks.length + outputImages.length;
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

  let weekId: string | null = null;
  if (b.week_id !== undefined && b.week_id !== null && b.week_id !== "") {
    if (typeof b.week_id !== "string" || !isUuid(b.week_id)) {
      return { ok: false, status: 400, error: "week_id must be a UUID" };
    }
    weekId = b.week_id;
  }

  let submissionOpensAt: string | null = null;
  if (b.submission_opens_at !== undefined && b.submission_opens_at !== null && b.submission_opens_at !== "") {
    if (typeof b.submission_opens_at !== "string") {
      return { ok: false, status: 400, error: "submission_opens_at must be a string" };
    }
    submissionOpensAt = b.submission_opens_at;
  }
  let submissionClosesAt: string | null = null;
  if (b.submission_closes_at !== undefined && b.submission_closes_at !== null && b.submission_closes_at !== "") {
    if (typeof b.submission_closes_at !== "string") {
      return { ok: false, status: 400, error: "submission_closes_at must be a string" };
    }
    submissionClosesAt = b.submission_closes_at;
  }

  return {
    ok: true,
    value: {
      competency_line_master_id: b.competency_line_master_id,
      output_link_1: outputLink1,
      output_link_2: outputLink2,
      output_links: outputLinks,
      output_images: outputImages,
      target_user_ids: targetUserIds,
      week_id: weekId,
      submission_opens_at: submissionOpensAt,
      submission_closes_at: submissionClosesAt,
    },
  };
}

const DAY_MS = 86_400_000;

function deriveSubmissionWindow(weekStartIso: string): {
  submissionOpensAt: string;
  submissionClosesAt: string;
} {
  const weekStartMs = Date.UTC(
    +weekStartIso.slice(0, 4),
    +weekStartIso.slice(5, 7) - 1,
    +weekStartIso.slice(8, 10),
  );
  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  // KST = UTC+9 ⇒ open=주 시작 00:00 KST(-9h UTC), close=Wed 22:00 KST(+13h UTC).
  return {
    submissionOpensAt: new Date(weekStartMs - 9 * 3600_000).toISOString(),
    submissionClosesAt: new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

function resolveCurrentWeek(): {
  weekStart: string;
  weekEnd: string;
  weekNumber: number;
  isoYear: number;
  isoWeek: number;
  isOfficialRest: boolean;
  submissionOpensAt: string;
  submissionClosesAt: string;
} | null {
  const todayIso = getCurrentActivityDateIso();
  const season = getSeasonForDate(todayIso);
  if (!season) return null;

  const seasonStartMs = Date.UTC(+season.startDate.slice(0, 4), +season.startDate.slice(5, 7) - 1, +season.startDate.slice(8, 10));
  const dateMs = Date.UTC(+todayIso.slice(0, 4), +todayIso.slice(5, 7) - 1, +todayIso.slice(8, 10));
  const weekIndex = Math.floor((dateMs - seasonStartMs) / (7 * DAY_MS));
  const weekNumber = weekIndex + 1;
  const weekStartMs = seasonStartMs + weekIndex * 7 * DAY_MS;
  const weekEndMs = weekStartMs + 6 * DAY_MS;

  const calendarStatus = getCalendarWeekStatus(season.type, weekNumber, season.seasonWeeks);
  const isOfficialRest = calendarStatus === "official_rest" || calendarStatus === "transition";

  const d = new Date(`${new Date(weekStartMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);

  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  const submissionOpensAt = new Date(weekStartMs - 9 * 3600_000).toISOString();
  const submissionClosesAt = new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString();

  return {
    weekStart: new Date(weekStartMs).toISOString().slice(0, 10),
    weekEnd: new Date(weekEndMs).toISOString().slice(0, 10),
    weekNumber,
    isoYear,
    isoWeek,
    isOfficialRest,
    submissionOpensAt,
    submissionClosesAt,
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return Response.json({ success: false, error: parsed.error }, { status: parsed.status });
  }

  const input = parsed.value;

  // ── 조직 + 운영/테스트 스코프 강제 (cluster4_line_targets 혼입 방지) ─────────
  //   info-lines POST 와 동일 가드. 개설 대상(target_user_ids)은 (현재 org 소속) AND
  //   (현재 mode 모집단) 둘 다여야 한다. operating=실사용자만 / test=test_user_markers 만.
  //   org 지정(?organization) 시 전원 그 org 소속이어야(동명이인 타org 차단). 위반 시 DB write 0.
  const scopeMode = readScopeMode(request.nextUrl.searchParams);
  const scopeOrgRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  const scopeOrg = isOrganizationSlug(scopeOrgRaw) ? scopeOrgRaw : null;

  // 1) mode 가드 — test_user_markers 등재 여부 축(operating↔test 혼입 422).
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
    // 1. Resolve target week — override 우선, 미지정 시 current week.
    let weekRowId: string;
    let submissionOpensAt: string;
    let submissionClosesAt: string;

    if (input.week_id) {
      const { data: weekRow, error: weekError } = await supabaseAdmin
        .from("weeks")
        .select("id,start_date,end_date")
        .eq("id", input.week_id)
        .maybeSingle();
      if (weekError) return Response.json({ success: false, error: weekError.message }, { status: 500 });
      if (!weekRow) return Response.json({ success: false, error: "지정한 주차를 찾을 수 없습니다" }, { status: 404 });
      const startDate = (weekRow as { start_date: string }).start_date;
      // 공식 휴식 = seasonCalendar rule ∨ official_rest_periods overlap.
      // weeks.is_official_rest 는 참조하지 않는다.
      const rest = await resolveWeekOfficialRest({
        startDate,
        endDate: (weekRow as { end_date: string | null }).end_date,
      });
      // 공식 휴식이라도 "해당 주차 전체(scope=all)" 라인 개설 예외가 활성이면 허용(휴식 차단 덮어씀).
      //   info-lines 게이트·assertWeekOpenable 과 동일 정책(세 허브 공용). 예외 없으면 종전대로 400.
      if (rest.isOfficialRest && !(await hasActiveAllLineException(input.week_id, scopeOrg, "competency"))) {
        return Response.json(
          { success: false, error: "공식 휴식 주차에는 라인을 개설할 수 없습니다" },
          { status: 400 },
        );
      }
      weekRowId = (weekRow as { id: string }).id;
      const derived = deriveSubmissionWindow(startDate);
      submissionOpensAt = input.submission_opens_at ?? derived.submissionOpensAt;
      submissionClosesAt = input.submission_closes_at ?? derived.submissionClosesAt;
    } else {
      const week = resolveCurrentWeek();
      if (!week || week.isOfficialRest) {
        return Response.json(
          { success: false, error: "현재 주차에 라인을 개설할 수 없습니다" },
          { status: 400 },
        );
      }

      const { data: weekRow, error: weekError } = await supabaseAdmin
        .from("weeks")
        .select("id,start_date,end_date")
        .eq("iso_year", week.isoYear)
        .eq("iso_week", week.isoWeek)
        .maybeSingle();
      if (weekError) return Response.json({ success: false, error: weekError.message }, { status: 500 });
      if (!weekRow) return Response.json({ success: false, error: "현재 주차 데이터를 찾을 수 없습니다" }, { status: 404 });
      // 현재 주차도 날짜형 공식 휴식(설/추석/임시)과 겹치면 차단.
      const rest = await resolveWeekOfficialRest({
        startDate: (weekRow as { start_date: string }).start_date,
        endDate: (weekRow as { end_date: string | null }).end_date,
      });
      if (rest.isOfficialRest) {
        return Response.json(
          { success: false, error: "현재 주차에 라인을 개설할 수 없습니다" },
          { status: 400 },
        );
      }
      weekRowId = (weekRow as { id: string }).id;
      submissionOpensAt = week.submissionOpensAt;
      submissionClosesAt = week.submissionClosesAt;
    }

    // 2. Lookup line_code + main_title — (2E-3) line_registrations(bridged 역참조) 우선,
    //    미연결이면 기존 마스터 fallback (운영 중단 방지). 필드 의미는 마스터와 등가
    //    (2E-1 diff 0 + 2E-2 sync 가드). cluster4_lines 에는 기존대로 master FK 를 기록한다.
    let lineCode: string;
    let mainTitle: string;
    const reg = await getRegistrationByBridgedMasterId(input.competency_line_master_id);
    if (reg) {
      if (!reg.isActive) {
        return Response.json({ success: false, error: "해당 라인을 찾을 수 없습니다" }, { status: 404 });
      }
      lineCode = reg.lineCode;
      mainTitle = reg.mainTitle ?? reg.lineName;
    } else {
      const { data: master, error: masterError } = await supabaseAdmin
        .from("cluster4_competency_line_masters")
        .select("id,line_code,line_name,main_title")
        .eq("id", input.competency_line_master_id)
        .eq("is_active", true)
        .maybeSingle();
      if (masterError) return Response.json({ success: false, error: masterError.message }, { status: 500 });
      if (!master) return Response.json({ success: false, error: "해당 라인을 찾을 수 없습니다" }, { status: 404 });
      lineCode = (master as { line_code: string }).line_code;
      mainTitle = (master as { main_title: string | null; line_name: string }).main_title
        ?? (master as { line_name: string }).line_name;
    }

    // 2.5 주차 단위 중복 체크: 같은 주차 + competency_line_master_id 의 active 라인이 있으면 차단.
    // (cluster4_lines 에는 week_id 가 없어 cluster4_line_targets.week_id 로 판정한다.)
    const { data: compActiveLines, error: compActiveErr } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "competency")
      .eq("competency_line_master_id", input.competency_line_master_id)
      .eq("is_active", true);
    if (compActiveErr) {
      return Response.json({ success: false, error: compActiveErr.message }, { status: 500 });
    }
    const compActiveLineIds = (compActiveLines ?? []).map((l) => (l as { id: string }).id);
    if (compActiveLineIds.length > 0) {
      const { data: compClash, error: compClashErr } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("id")
        .eq("week_id", weekRowId)
        .in("line_id", compActiveLineIds)
        .limit(1);
      if (compClashErr) {
        return Response.json({ success: false, error: compClashErr.message }, { status: 500 });
      }
      if (compClash && compClash.length > 0) {
        return Response.json(
          { success: false, error: "선택한 주차에는 이 역량 라인의 활성 라인이 이미 있습니다" },
          { status: 409 },
        );
      }
    }

    // 3. Create cluster4_lines row
    const { data: lineRow, error: lineError } = await supabaseAdmin
      .from("cluster4_lines")
      .insert({
        part_type: "competency",
        competency_line_master_id: input.competency_line_master_id,
        line_code: lineCode,
        main_title: mainTitle,
        output_link_1: input.output_link_1,
        output_link_2: input.output_link_2,
        output_links: input.output_links,
        output_images: input.output_images,
        submission_opens_at: submissionOpensAt,
        submission_closes_at: submissionClosesAt,
        is_active: true,
        created_by: admin.userId,
        updated_by: admin.userId,
      })
      .select("id,part_type,line_code,competency_line_master_id,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at")
      .single();

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create competency line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }

    // 4. Bulk-create targets
    const targetRows = input.target_user_ids.map((userId) => ({
      line_id: lineRow.id,
      week_id: weekRowId,
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
      console.error("[competency-lines POST] targets insert failed", targetError);
      return Response.json(
        { success: false, error: `라인은 생성되었으나 대상 등록에 실패했습니다: ${targetError.message}`, data: { lineId: lineRow.id } },
        { status: 500 },
      );
    }

    // 대상자 weekly-cards snapshot 즉시 재계산 → 고객 앱에 실제 라인이 바로 내려오게 한다.
    // (cron 축소로 stale-only 는 미반영) ≤10명 즉시 / >10명 백그라운드. best-effort.
    await invalidateWeeklyCardsForUsers(input.target_user_ids);

    return Response.json(
      { success: true, data: { line: lineRow, targets: targets ?? [], targetCount: input.target_user_ids.length } },
      { status: 201 },
    );
  } catch (error) {
    console.error("[competency-lines POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create competency line" },
      { status: 500 },
    );
  }
}
