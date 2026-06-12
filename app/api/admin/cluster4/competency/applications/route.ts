import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isOrganizationSlug } from "@/lib/organizations";
import { isUuid } from "@/lib/isUuid";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import {
  addManualCompetencyApplication,
  getCompetencyApplicationSummary,
  getCompetencyLineResults,
  listCompetencyApplications,
} from "@/lib/adminCompetencyApplications";

// 실무 역량 [라인 개설] 신청/승인 명단.
//   GET  ?organization=&week_id?=  → { applications, summary, weekId } (week_id 미지정 시 개설 대상 주차)
//   POST { organization, target_user_id, line_name, competency_line_master_id?, submission_link? }
//        → 운영자 수동 추가(source='manual')
//
// 기본 대상 주차 = 개설 대상(금요일 경계 = openable week). 상태창/로그 API 와 동일 SoT 헬퍼.
// week_id 지정 시(라인 관리 탭 주차 드롭다운) 그 주차 기준 집계 — 같은 DTO 로 주차만 바꿔 조회한다.

async function resolveTargetWeekId(): Promise<string | null> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const openableStartMs = getOpenableWeekStartMs(todayIso);
  const info = openableStartMs != null ? describeWeekByStartMs(openableStartMs) : null;
  if (!info) return null;
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("iso_year", info.isoYear)
    .eq("iso_week", info.isoWeek)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const orgRaw = request.nextUrl.searchParams.get("organization")?.trim() || null;
  const org = isOrganizationSlug(orgRaw) ? orgRaw : null;

  try {
    // week_id 지정 시 그 주차(라인 관리 탭 드롭다운), 미지정/무효 시 개설 대상 주차.
    const weekParam = request.nextUrl.searchParams.get("week_id")?.trim() || null;
    const weekId =
      weekParam && isUuid(weekParam) ? weekParam : await resolveTargetWeekId();
    if (!org || !weekId) {
      return Response.json({
        success: true,
        data: {
          applications: [],
          summary: {
            activeCrews: 0,
            appliedCrews: 0,
            openedCrews: 0,
            rejectedCrews: 0,
            appliedLines: 0,
            openedLines: 0,
          },
          results: [],
          weekId,
        },
      });
    }
    const [applications, summary, results] = await Promise.all([
      listCompetencyApplications(org, weekId),
      getCompetencyApplicationSummary(org, weekId),
      getCompetencyLineResults(org, weekId),
    ]);
    return Response.json({ success: true, data: { applications, summary, results, weekId } });
  } catch (error) {
    console.error("[admin/cluster4/competency/applications GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "신청 명단을 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
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
  const b = (body ?? {}) as Record<string, unknown>;

  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "organization 은 유효한 조직이어야 합니다" },
      { status: 400 },
    );
  }
  const targetUserId = typeof b.target_user_id === "string" ? b.target_user_id : "";
  if (!isUuid(targetUserId)) {
    return Response.json(
      { success: false, error: "target_user_id(크루)를 선택해주세요" },
      { status: 400 },
    );
  }
  const lineName = typeof b.line_name === "string" ? b.line_name.trim() : "";
  if (!lineName) {
    return Response.json({ success: false, error: "라인을 선택해주세요" }, { status: 400 });
  }
  const masterIdRaw = typeof b.competency_line_master_id === "string" ? b.competency_line_master_id : null;
  const masterId = masterIdRaw && isUuid(masterIdRaw) ? masterIdRaw : null;
  // 존재하지 않는 라인 자유 입력 방지 — 수동 추가는 드롭다운(master) 선택 필수.
  if (!masterId) {
    return Response.json(
      { success: false, error: "라인을 드롭다운에서 선택해주세요" },
      { status: 400 },
    );
  }
  const lineCode = typeof b.line_code === "string" ? b.line_code.trim() || null : null;
  const submissionLink = typeof b.submission_link === "string" ? b.submission_link : null;

  try {
    const weekId = await resolveTargetWeekId();
    if (!weekId) {
      return Response.json(
        { success: false, error: "개설 대상 주차 정보를 확인할 수 없습니다" },
        { status: 400 },
      );
    }
    const result = await addManualCompetencyApplication({
      org: orgRaw,
      weekId,
      targetUserId,
      lineName,
      competencyLineMasterId: masterId,
      lineCode,
      submissionLink,
      adminId: admin.userId,
    });
    return Response.json({ success: true, data: result }, { status: 201 });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/competency/applications POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "수동 추가에 실패했습니다",
      },
      { status },
    );
  }
}
