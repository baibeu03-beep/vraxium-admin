import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import {
  getSeasonForDate,
  getCalendarWeekStatus,
} from "@/lib/seasonCalendar";
import { resolveWeekOfficialRest } from "@/lib/officialRestPeriodsData";
import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  outputLinksToLegacySlots,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";

type CareerLineCreateBody = {
  career_project_id: string;
  main_title: string;
  output_link_1: string | null;
  output_link_2: string | null;
  output_links: Cluster4OutputLink[];
  output_images: string[];
  target_user_ids: string[];
  // 어드민/테스트 모드 override — 미지정 시 서버가 current week 로 폴백.
  week_id: string | null;
  submission_opens_at: string | null;
  submission_closes_at: string | null;
};

function parseBody(
  body: unknown,
): { ok: true; value: CareerLineCreateBody } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.career_project_id !== "string" || !isUuid(b.career_project_id)) {
    return { ok: false, status: 400, error: "career_project_id is required (UUID)" };
  }

  if (typeof b.main_title !== "string" || b.main_title.trim().length === 0) {
    return { ok: false, status: 400, error: "메인 타이틀을 입력해주세요" };
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
      career_project_id: b.career_project_id,
      main_title: b.main_title.trim(),
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
  return {
    submissionOpensAt: new Date(weekStartMs - 9 * 3600_000).toISOString(),
    submissionClosesAt: new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

function resolveCurrentWeek(): {
  isoYear: number;
  isoWeek: number;
  isOfficialRest: boolean;
  submissionOpensAt: string;
  submissionClosesAt: string;
} | null {
  const todayIso = new Date().toISOString().slice(0, 10);
  const season = getSeasonForDate(todayIso);
  if (!season) return null;

  const seasonStartMs = Date.UTC(
    +season.startDate.slice(0, 4),
    +season.startDate.slice(5, 7) - 1,
    +season.startDate.slice(8, 10),
  );
  const dateMs = Date.UTC(
    +todayIso.slice(0, 4),
    +todayIso.slice(5, 7) - 1,
    +todayIso.slice(8, 10),
  );
  const weekIndex = Math.floor((dateMs - seasonStartMs) / (7 * DAY_MS));
  const weekNumber = weekIndex + 1;
  const weekStartMs = seasonStartMs + weekIndex * 7 * DAY_MS;

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

  return { isoYear, isoWeek, isOfficialRest, submissionOpensAt, submissionClosesAt };
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

  try {
    // Resolve target week — override 우선, 미지정 시 current week.
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
      if (rest.isOfficialRest) {
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

    const { data: project, error: projectError } = await supabaseAdmin
      .from("career_projects")
      .select("id,line_code,line_name,default_target_user_ids")
      .eq("id", input.career_project_id)
      .maybeSingle();
    if (projectError) return Response.json({ success: false, error: projectError.message }, { status: 500 });
    if (!project) return Response.json({ success: false, error: "해당 경력 프로젝트를 찾을 수 없습니다" }, { status: 404 });

    const lineCode = (project as { line_code: string | null }).line_code;

    // 선발 검증 (P1): 실무 경력은 선발된 크루만 대상자가 될 수 있다.
    // 선발 SoT = career_projects.default_target_user_ids (등록 시 입력한 "선발 크루" 로스터).
    // target_user_ids ⊄ 선발 로스터 면 차단한다.
    const rawSelected = (project as { default_target_user_ids: unknown }).default_target_user_ids;
    const selectedUserIds = new Set(
      Array.isArray(rawSelected)
        ? rawSelected.filter((v): v is string => typeof v === "string")
        : [],
    );
    if (selectedUserIds.size === 0) {
      return Response.json(
        { success: false, error: "선발된 크루가 없습니다. 경력 라인 등록에서 선발 크루를 먼저 지정해주세요" },
        { status: 400 },
      );
    }
    const notSelected = input.target_user_ids.filter((uid) => !selectedUserIds.has(uid));
    if (notSelected.length > 0) {
      return Response.json(
        {
          success: false,
          error: "선발되지 않은 사용자는 대상자로 지정할 수 없습니다",
          data: { notSelected },
        },
        { status: 400 },
      );
    }

    // 주차 단위 중복 체크: 같은 주차 + career_project_id 의 active 라인이 있으면 차단.
    // (cluster4_lines 에는 week_id 가 없어 cluster4_line_targets.week_id 로 판정한다.)
    const { data: careerActiveLines, error: careerActiveErr } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("part_type", "career")
      .eq("career_project_id", input.career_project_id)
      .eq("is_active", true);
    if (careerActiveErr) {
      return Response.json({ success: false, error: careerActiveErr.message }, { status: 500 });
    }
    const careerActiveLineIds = (careerActiveLines ?? []).map((l) => (l as { id: string }).id);
    if (careerActiveLineIds.length > 0) {
      const { data: careerClash, error: careerClashErr } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("id")
        .eq("week_id", weekRowId)
        .in("line_id", careerActiveLineIds)
        .limit(1);
      if (careerClashErr) {
        return Response.json({ success: false, error: careerClashErr.message }, { status: 500 });
      }
      if (careerClash && careerClash.length > 0) {
        return Response.json(
          { success: false, error: "선택한 주차에는 이 경력 프로젝트의 활성 라인이 이미 있습니다" },
          { status: 409 },
        );
      }
    }

    const { data: lineRow, error: lineError } = await supabaseAdmin
      .from("cluster4_lines")
      .insert({
        part_type: "career",
        career_project_id: input.career_project_id,
        line_code: lineCode,
        main_title: input.main_title,
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
      .select("id,part_type,career_project_id,line_code,main_title,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,is_active,created_at")
      .single();

    if (lineError || !lineRow) {
      const msg = lineError?.message ?? "Failed to create career line";
      const status = lineError?.code === "23505" ? 409 : 500;
      return Response.json({ success: false, error: msg }, { status });
    }

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
      console.error("[career-lines POST] targets insert failed", targetError);
      return Response.json(
        { success: false, error: `라인은 생성되었으나 대상 등록에 실패했습니다: ${targetError.message}`, data: { lineId: lineRow.id } },
        { status: 500 },
      );
    }

    return Response.json(
      { success: true, data: { line: lineRow, targets: targets ?? [], targetCount: input.target_user_ids.length } },
      { status: 201 },
    );
  } catch (error) {
    console.error("[career-lines POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to create career line" },
      { status: 500 },
    );
  }
}
