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
  assertUserIdsInScope,
  readScopeMode,
  resolveUserScope,
  type ScopeMode,
} from "@/lib/userScope";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";
import { resolveCompetencyTestWeekOverrideMs } from "@/lib/cluster4CompetencyTestWeekException";
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

// 개설 대상 주차 = 금요일 경계 openable week. 단, test 모드는 역량 허브 W13 예외를 적용해
//   상태창/개설 플로우(adminCompetencyLineOpening.resolveWeeks)와 동일한 주차로 정렬한다.
//   (예외 미적용 시 test 모드에서 개설은 W13, 신청자 집계는 정규주차로 어긋남 — read/write 주차 불일치)
//   resolveCompetencyTestWeekOverrideMs 는 operating·비역량시즌에서 null → 정규주차 그대로(운영 정책 무변).
async function resolveTargetWeekId(mode: ScopeMode): Promise<string | null> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const regularOpenableStartMs = getOpenableWeekStartMs(todayIso);
  const openableStartMs =
    regularOpenableStartMs == null
      ? null
      : resolveCompetencyTestWeekOverrideMs(mode, regularOpenableStartMs) ??
        regularOpenableStartMs;
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
  // 운영/테스트 모드 — 활동 크루 집계/결과 모집단을 결정(operating=실사용자 / test=test_user_markers).
  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    // week_id 지정 시 그 주차(라인 관리 탭 드롭다운), 미지정/무효 시 개설 대상 주차.
    const weekParam = request.nextUrl.searchParams.get("week_id")?.trim() || null;
    const weekId =
      weekParam && isUuid(weekParam) ? weekParam : await resolveTargetWeekId(mode);
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
      getCompetencyApplicationSummary(org, weekId, mode),
      getCompetencyLineResults(org, weekId, mode),
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

  // ── 조직 + 운영/테스트 스코프 강제 (cluster4_competency_applications/line_targets 혼입 방지) ──
  //   수동 추가 대상(target_user_id)은 (현재 org 소속) AND (현재 mode 모집단) 둘 다여야 한다.
  //     mode : operating=실사용자만 / test=test_user_markers 만 (422 on mismatch).
  //     org  : target 이 그 organization_slug 소속이어야(동명이인 타org 차단, 422).
  //   하나라도 어긋나면 insert 전 중단(DB write 0). info-lines POST 가드와 동일 패턴.
  const scopeMode = readScopeMode(request.nextUrl.searchParams);
  try {
    const scope = await resolveUserScope(scopeMode, orgRaw);
    assertUserIdsInScope(scope, [targetUserId]);
  } catch (error) {
    if ((error as { status?: number })?.status === 422) {
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 422 },
      );
    }
    throw error;
  }
  {
    const { data: profileRow, error: profileErr } = await supabaseAdmin
      .from("user_profiles")
      .select("organization_slug")
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (profileErr) {
      return Response.json({ success: false, error: profileErr.message }, { status: 500 });
    }
    const targetOrg = (profileRow as { organization_slug: string | null } | null)?.organization_slug ?? null;
    if (targetOrg !== orgRaw) {
      return Response.json(
        {
          success: false,
          error: `현재 조직(${orgRaw}) 소속이 아닌 사용자는 추가할 수 없습니다.`,
        },
        { status: 422 },
      );
    }
  }

  try {
    const weekId = await resolveTargetWeekId(scopeMode);
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
