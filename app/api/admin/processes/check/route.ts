// /api/admin/processes/check — 프로세스 체크 보드 + 액션(체크 신청/취소).
//
//   GET  ?hub=info&org=oranke[&week=<weekId>]
//          → 보드 DTO(주차 드롭다운 + 선택주차 [섹션.1] 액트 + 상태창1/2 + 로그). week 미지정=현재 주차.
//          과거 주차 = 조회 전용(editable=false → 모든 쓰기 버튼 비활성).
//   POST { hub, organization, act_id, action: 'request'|'cancel', review_link?, scheduled_check_at? }
//          request → needed→pending(검수 링크/시점 저장) · cancel → pending→needed(검수 시점 전만)
//
// 상태 저장 + 로그 기록까지만 — user_weekly_points.points/주차 성장 계산/snapshot/크롤링 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { isProcessHub } from "@/lib/adminProcessesTypes";
import {
  isProcessCheckAction,
  isProcessCheckScopeKind,
  type ProcessCheckScopeKind,
} from "@/lib/adminProcessCheckTypes";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import {
  applyProcessCheckAction,
  applyProcessManualGrant,
  getProcessCheckBoard,
} from "@/lib/adminProcessCheckData";
import { publicErrorMessage } from "@/lib/apiError";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const hubRaw = request.nextUrl.searchParams.get("hub")?.trim() ?? null;
  if (!isProcessHub(hubRaw)) {
    return Response.json(
      { success: false, error: "소속 허브를 다시 선택해주세요." },
      { status: 400 },
    );
  }
  const orgRaw = request.nextUrl.searchParams.get("org")?.trim() || null;
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "소속 클럽을 다시 선택해주세요." },
      { status: 400 },
    );
  }
  // team(선택) — experience 섹션.1 팀 스코프. uuid 형식만 검증(소속 검증은 데이터레이어).
  const teamRaw = request.nextUrl.searchParams.get("team")?.trim() || null;
  if (teamRaw && !UUID_RE.test(teamRaw)) {
    return Response.json({ success: false, error: "팀 값이 올바르지 않습니다." }, { status: 400 });
  }
  // scope/part(선택) — experience 섹션.1 팀·파트 스코프. 형식만 통과(소속/유효성은 데이터레이어).
  const scope = isProcessCheckScopeKind(request.nextUrl.searchParams.get("scope"))
    ? (request.nextUrl.searchParams.get("scope") as ProcessCheckScopeKind)
    : null;
  const partRaw = request.nextUrl.searchParams.get("part")?.trim() || null;

  // 팀 목록 스코프(operating=운영 팀만 / test=(T) 팀만). 기본 operating.
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));
  // 선택 주차(드롭다운) — 목록 밖/형식 오류면 데이터레이어가 현재 주차로 폴백. 과거 주차 = 조회 전용.
  const weekRaw = request.nextUrl.searchParams.get("week")?.trim() || null;
  const selectedWeekId = weekRaw && UUID_RE.test(weekRaw) ? weekRaw : null;

  try {
    const data = await getProcessCheckBoard(hubRaw, orgRaw, teamRaw, mode, scope, partRaw, selectedWeekId);
    return Response.json({ success: true, data });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/check GET]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "체크 처리를 완료하지 못했습니다.") },
      { status },
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
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const hub = b.hub;
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";
  const actId = typeof b.act_id === "string" ? b.act_id.trim() : "";
  const teamId = typeof b.team_id === "string" && b.team_id.trim() ? b.team_id.trim() : null;
  const action = b.action;
  // 팀·파트 스코프(experience) — team_all|team_overall|part + part_name(part 일 때, 실제 팀 파트).
  //   형식만 통과시키고 소속/유효성 검증은 데이터레이어(applyProcessCheckAction)에서 fail-closed.
  const scope = isProcessCheckScopeKind(b.scope) ? b.scope : null;
  const partName =
    typeof b.part_name === "string" && b.part_name.trim() ? b.part_name.trim() : null;
  // 스코프 모드(operating=현재 주차 / test=info 13주차 예외). GET 과 동일 SoT(parseScopeMode).
  //   ⚠ 저장 주차가 보드 조회 주차와 일치하도록 write 경로도 mode 를 받아 전달한다.
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);
  // 선택 주차(weeks.id) — 현재 주차와 다르면 데이터레이어가 활성 예외(process_check_windows)일 때만 허용.
  //   미부착/형식오류면 현재 주차(기존 동작 불변).
  const weekRaw = typeof b.week === "string" && b.week.trim() ? b.week.trim() : null;
  const selectedWeekId = weekRaw && UUID_RE.test(weekRaw) ? weekRaw : null;

  if (!isProcessHub(hub)) {
    return Response.json(
      { success: false, error: "소속 허브를 다시 선택해주세요." },
      { status: 400 },
    );
  }
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json({ success: false, error: "소속 클럽을 다시 선택해주세요." }, { status: 400 });
  }
  if (!actId) {
    return Response.json({ success: false, error: "액트를 선택해주세요." }, { status: 400 });
  }
  // uuid 형식 검증 — 잘못된 형식이 uuid 컬럼 쿼리로 가 500 나는 것을 막는다(→ 400).
  if (!UUID_RE.test(actId)) {
    return Response.json({ success: false, error: "액트 값이 올바르지 않습니다." }, { status: 400 });
  }
  if (teamId && !UUID_RE.test(teamId)) {
    return Response.json({ success: false, error: "팀 값이 올바르지 않습니다." }, { status: 400 });
  }

  // 선별(selection) 액트 수동 부여 — 대상 크루 명단 + 자유 입력 포인트(A→check·B→advantage·C→penalty).
  //   request|cancel 과 페이로드가 달라 별도 분기(액트 종류·스코프·중복 방지는 데이터레이어 fail-closed).
  if (action === "manual_grant") {
    const targetIds = Array.isArray(b.target_user_ids) ? b.target_user_ids : [];
    for (const id of targetIds) {
      if (typeof id !== "string" || !UUID_RE.test(id.trim())) {
        return Response.json({ success: false, error: "대상자 값이 올바르지 않습니다." }, { status: 400 });
      }
    }
    try {
      const data = await applyProcessManualGrant({
        hub,
        organization: orgRaw,
        actId,
        teamId,
        scope,
        partName,
        mode,
        weekId: selectedWeekId,
        adminId: admin.userId,
        targetUserIds: (targetIds as string[]).map((x) => x.trim()),
        durationMinutes: b.duration_minutes,
        reason: b.reason,
        pointCheck: b.point_a,
        pointAdvantage: b.point_b,
        pointPenalty: b.point_c,
      });
      return Response.json({ success: true, data }, { status: 201 });
    } catch (error) {
      const status = error instanceof ProcessMasterError ? error.status : 500;
      console.error("[processes/check POST manual_grant]", error);
      return Response.json(
        { success: false, error: publicErrorMessage(error, status, "체크 처리를 완료하지 못했습니다.") },
        { status },
      );
    }
  }

  if (!isProcessCheckAction(action)) {
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  try {
    const data = await applyProcessCheckAction({
      hub,
      organization: orgRaw,
      actId,
      action,
      teamId,
      scope,
      partName,
      reviewLink: b.review_link,
      scheduledCheckAt: b.scheduled_check_at,
      adminId: admin.userId,
      mode,
      weekId: selectedWeekId,
    });
    return Response.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/check POST]", error);
    return Response.json(
      { success: false, error: publicErrorMessage(error, status, "체크 처리를 완료하지 못했습니다.") },
      { status },
    );
  }
}
