// /api/admin/processes/check — 프로세스 체크 보드 + 액션(체크 신청/취소).
//
//   GET  ?hub=info&org=oranke  → 보드 DTO(현재 주차 + [섹션.1] 액트 + 상태창1/2 + 로그)
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
import { isProcessCheckAction } from "@/lib/adminProcessCheckTypes";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import {
  applyProcessCheckAction,
  getProcessCheckBoard,
} from "@/lib/adminProcessCheckData";

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
      { success: false, error: "hub must be one of club|info|experience|competency|career" },
      { status: 400 },
    );
  }
  const orgRaw = request.nextUrl.searchParams.get("org")?.trim() || null;
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "org 은 유효한 조직(encre|oranke|phalanx)이어야 합니다" },
      { status: 400 },
    );
  }
  // team(선택) — experience 섹션.1 팀 스코프. uuid 형식만 검증(소속 검증은 데이터레이어).
  const teamRaw = request.nextUrl.searchParams.get("team")?.trim() || null;
  if (teamRaw && !UUID_RE.test(teamRaw)) {
    return Response.json({ success: false, error: "team 형식이 올바르지 않습니다" }, { status: 400 });
  }

  // 팀 목록 스코프(operating=운영 팀만 / test=(T) 팀만). 기본 operating.
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));

  try {
    const data = await getProcessCheckBoard(hubRaw, orgRaw, teamRaw, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/check GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
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
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const b = (body ?? {}) as Record<string, unknown>;
  const hub = b.hub;
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";
  const actId = typeof b.act_id === "string" ? b.act_id.trim() : "";
  const teamId = typeof b.team_id === "string" && b.team_id.trim() ? b.team_id.trim() : null;
  const action = b.action;
  // 스코프 모드(operating=현재 주차 / test=info 13주차 예외). GET 과 동일 SoT(parseScopeMode).
  //   ⚠ 저장 주차가 보드 조회 주차와 일치하도록 write 경로도 mode 를 받아 전달한다.
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);

  if (!isProcessHub(hub)) {
    return Response.json(
      { success: false, error: "hub must be one of club|info|experience|competency|career" },
      { status: 400 },
    );
  }
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json({ success: false, error: "organization 은 유효한 조직이어야 합니다" }, { status: 400 });
  }
  if (!actId) {
    return Response.json({ success: false, error: "act_id is required" }, { status: 400 });
  }
  // uuid 형식 검증 — 잘못된 형식이 uuid 컬럼 쿼리로 가 500 나는 것을 막는다(→ 400).
  if (!UUID_RE.test(actId)) {
    return Response.json({ success: false, error: "act_id 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (teamId && !UUID_RE.test(teamId)) {
    return Response.json({ success: false, error: "team_id 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (!isProcessCheckAction(action)) {
    return Response.json({ success: false, error: "action 은 request|cancel 이어야 합니다" }, { status: 400 });
  }

  try {
    const data = await applyProcessCheckAction({
      hub,
      organization: orgRaw,
      actId,
      action,
      teamId,
      reviewLink: b.review_link,
      scheduledCheckAt: b.scheduled_check_at,
      adminId: admin.userId,
      mode,
    });
    return Response.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const status = error instanceof ProcessMasterError ? error.status : 500;
    console.error("[processes/check POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status },
    );
  }
}
