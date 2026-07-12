// /api/admin/processes/check/irregular — 변동 액트 보드 + 액션(검수 링크/수동 입력/완료/삭제).
//
//   GET    ?org=oranke[&mode=test][&week=<weekId>]
//            → 보드 DTO(주차 드롭다운 + 선택주차 요약 7칸 + 액트 목록). week 미지정/목록밖이면 현재 주차.
//            과거 주차 = 조회 전용(editable=false). 검수 시점 경과 검수링크는 응답에서 '체크 완료'로 파생.
//   POST   { organization, mode?, kind, act_name, target_user_id, ... }
//            kind=review_request → pending(검수링크/검수시점 필수) · manual_grant → 즉시 completed
//   PATCH  { id, organization, mode?, action:'complete' }   → pending → completed
//   DELETE { id, organization, mode? }                       → 행 제거(관리용)
//
// org + test/operating 모드 분리는 target_user_id 기준(스코프 불일치 422). 신청자=현재 로그인 운영진.
// ⚠ user_weekly_points · 주차 성장 · snapshot · checkGate · demoUserId 무접촉.

import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { isOrganizationSlug } from "@/lib/organizations";
import { parseScopeMode } from "@/lib/userScopeShared";
import { ProcessMasterError } from "@/lib/adminProcessesData";
import {
  completeIrregularAct,
  createIrregularAct,
  createManualGrant,
  deleteIrregularAct,
  getIrregularBoard,
  setIrregularCrewReaction,
} from "@/lib/adminProcessIrregularData";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errStatus(error: unknown): number {
  return error instanceof ProcessMasterError
    ? error.status
    : typeof (error as { status?: unknown })?.status === "number"
      ? ((error as { status: number }).status)
      : 500;
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const orgRaw = request.nextUrl.searchParams.get("org")?.trim() || null;
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json(
      { success: false, error: "org 은 유효한 클럽(encre|oranke|phalanx)이어야 합니다" },
      { status: 400 },
    );
  }
  const mode = parseScopeMode(request.nextUrl.searchParams.get("mode"));
  // 선택 주차(드롭다운) — 목록 밖/형식 오류면 데이터레이어가 현재 주차로 폴백.
  const weekRaw = request.nextUrl.searchParams.get("week")?.trim() || null;
  const selectedWeekId = weekRaw && UUID_RE.test(weekRaw) ? weekRaw : null;

  try {
    const data = await getIrregularBoard(orgRaw, mode, selectedWeekId);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[processes/check/irregular GET]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: errStatus(error) },
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
    return Response.json({ success: false, error: "organization 은 유효한 클럽이어야 합니다" }, { status: 400 });
  }
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);
  // 선택 주차(weeks.id) — 현재와 다르면 데이터레이어가 활성 예외("irregular")일 때만 허용. 미부착=현재 주차.
  const weekRaw = typeof b.week === "string" && b.week.trim() ? b.week.trim() : null;
  const selectedWeekId = weekRaw && UUID_RE.test(weekRaw) ? weekRaw : null;

  // 대상 크루 명단(수동 입력) — 배열의 각 id uuid 형식 검증.
  const targetIds = Array.isArray(b.target_user_ids) ? b.target_user_ids : [];
  for (const id of targetIds) {
    if (typeof id !== "string" || !UUID_RE.test(id.trim())) {
      return Response.json({ success: false, error: "target_user_ids 형식이 올바르지 않습니다" }, { status: 400 });
    }
  }

  try {
    const data =
      b.kind === "manual_grant"
        ? await createManualGrant({
            organization: orgRaw,
            mode,
            adminId: admin.userId,
            actName: b.act_name,
            targetUserIds: targetIds,
            durationMinutes: b.duration_minutes,
            reason: b.reason,
            pointA: b.point_a,
            pointB: b.point_b,
            pointC: b.point_c,
            crewReaction: b.crew_reaction,
            pointMode: b.point_mode,
            weekId: selectedWeekId,
          })
        : await createIrregularAct({
            organization: orgRaw,
            mode,
            adminId: admin.userId,
            kind: b.kind,
            actName: b.act_name,
            durationMinutes: b.duration_minutes,
            reason: b.reason,
            pointA: b.point_a,
            pointB: b.point_b,
            pointC: b.point_c,
            crewReaction: b.crew_reaction,
            pointMode: b.point_mode,
            reviewLink: b.review_link,
            scheduledCheckAt: b.scheduled_check_at,
            weekId: selectedWeekId,
          });
    return Response.json({ success: true, data }, { status: 201 });
  } catch (error) {
    console.error("[processes/check/irregular POST]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: errStatus(error) },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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

  const id = typeof b.id === "string" ? b.id.trim() : "";
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);
  if (!id || !UUID_RE.test(id)) {
    return Response.json({ success: false, error: "id 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json({ success: false, error: "organization 은 유효한 클럽이어야 합니다" }, { status: 400 });
  }
  if (b.action !== "complete" && b.action !== "set_crew_reaction") {
    return Response.json(
      { success: false, error: "action 은 complete|set_crew_reaction 이어야 합니다" },
      { status: 400 },
    );
  }

  try {
    const data =
      b.action === "set_crew_reaction"
        ? await setIrregularCrewReaction(id, orgRaw, mode, b.crew_reaction, b.point_mode)
        : await completeIrregularAct(id, orgRaw, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[processes/check/irregular PATCH]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: errStatus(error) },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_WRITE_ROLES);
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

  const id = typeof b.id === "string" ? b.id.trim() : "";
  const orgRaw = typeof b.organization === "string" ? b.organization.trim() : "";
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);
  if (!id || !UUID_RE.test(id)) {
    return Response.json({ success: false, error: "id 형식이 올바르지 않습니다" }, { status: 400 });
  }
  if (!isOrganizationSlug(orgRaw)) {
    return Response.json({ success: false, error: "organization 은 유효한 클럽이어야 합니다" }, { status: 400 });
  }

  try {
    await deleteIrregularAct(id, orgRaw, mode);
    return Response.json({ success: true });
  } catch (error) {
    console.error("[processes/check/irregular DELETE]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: errStatus(error) },
    );
  }
}
