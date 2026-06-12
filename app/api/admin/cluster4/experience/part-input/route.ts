import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  EXPERIENCE_PART_LINE_TYPES,
  TEAM_OVERALL,
  isExperiencePartLineType,
  type PartInputCellDto,
  type PartInputGetData,
} from "@/lib/experiencePartInputTypes";
import {
  deletePartSubmission,
  getPartSubmission,
  getTeamOverall,
  listPartCrews,
  listTeamParts,
  resolveActorContext,
  savePartSubmission,
} from "@/lib/adminExperiencePartInput";
import { insertExperienceOpeningLog } from "@/lib/adminExperienceOpeningLogs";

// 실무 경험 파트장 입력 그리드 — 신청 데이터(신규 전용 저장) API.
//   GET    ?organization=&week_id=&team_id=&team_name=&part=  → 파트/크루/셀/신청상태 (+actor 기본값)
//   POST   { organization, week_id, team_id, team_name, part, cells[] }  → 신청 저장(upsert)
//   DELETE ?organization=&week_id=&team_id=&part=             → 신청 취소(헤더 삭제, 셀 cascade)
//
// ⚠ 기존 experience_drafts/검수/개설/snapshot 무연동. demo/일반 동일(org 스코프, demoUserId 미사용).

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sp = request.nextUrl.searchParams;
  const organization = sp.get("organization")?.trim() || "";
  const weekId = sp.get("week_id")?.trim() || "";
  const teamId = sp.get("team_id")?.trim() || "";
  const teamName = sp.get("team_name")?.trim() || "";
  const part = sp.get("part")?.trim() || "";

  try {
    const actorRaw = await resolveActorContext(admin.userId);
    const defaultPart =
      actorRaw.role === "part_leader" && actorRaw.partName
        ? actorRaw.partName
        : TEAM_OVERALL;
    const actor = { ...actorRaw, defaultPart };

    // 팀 미선택이면 파트/크루 없이 actor 기본값만(클라가 팀 선택 후 재조회).
    if (!organization || !teamName) {
      const data: PartInputGetData = {
        actor,
        lines: EXPERIENCE_PART_LINE_TYPES,
        parts: [],
        crews: [],
        cells: [],
        submitted: false,
        aggregate: null,
      };
      return Response.json({ success: true, data });
    }

    const parts = await listTeamParts(organization, teamName);

    // 팀 총괄(집계, 읽기 전용).
    if (part === TEAM_OVERALL) {
      const aggregate =
        weekId && teamId
          ? await getTeamOverall(organization, weekId, teamId, teamName)
          : { parts: [] };
      const data: PartInputGetData = {
        actor,
        lines: EXPERIENCE_PART_LINE_TYPES,
        parts,
        crews: [],
        cells: [],
        submitted: false,
        aggregate,
      };
      return Response.json({ success: true, data });
    }

    // 특정 파트 — 평가 대상 크루 + 저장된 셀 + 신청 상태.
    const crews = part ? await listPartCrews(organization, teamName, part) : [];
    const sub =
      part && weekId && teamId
        ? await getPartSubmission(organization, weekId, teamId, part)
        : { submitted: false, cells: [] };
    const data: PartInputGetData = {
      actor,
      lines: EXPERIENCE_PART_LINE_TYPES,
      parts,
      crews,
      cells: sub.cells,
      submitted: sub.submitted,
      aggregate: null,
    };
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/cluster4/experience/part-input GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "파트 입력 데이터를 불러오지 못했습니다",
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
  const organization = typeof b.organization === "string" ? b.organization.trim() : "";
  const weekId = typeof b.week_id === "string" ? b.week_id.trim() : "";
  const teamId = typeof b.team_id === "string" ? b.team_id.trim() : "";
  const part = typeof b.part === "string" ? b.part.trim() : "";

  if (!organization || !weekId || !teamId || !part) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, part 는 필수입니다" },
      { status: 400 },
    );
  }
  if (part === TEAM_OVERALL) {
    return Response.json(
      { success: false, error: "팀 총괄은 신청 대상이 아닙니다" },
      { status: 400 },
    );
  }

  // 셀 파싱/검증 — line_type/score 범위 가드(테이블 CHECK 와 이중).
  const rawCells = Array.isArray(b.cells) ? b.cells : [];
  const cells: PartInputCellDto[] = [];
  for (const c of rawCells) {
    const cell = c as Record<string, unknown>;
    const crewUserId = typeof cell.crewUserId === "string" ? cell.crewUserId : null;
    const lineType = cell.lineType;
    if (!crewUserId || !isExperiencePartLineType(lineType)) continue;
    const checked = Boolean(cell.checked);
    const scoreNum = Number(cell.score);
    const score = Number.isFinite(scoreNum)
      ? Math.max(0, Math.min(10, Math.round(scoreNum)))
      : 0;
    cells.push({ crewUserId, lineType, checked, score });
  }

  try {
    const result = await savePartSubmission({
      organization,
      weekId,
      teamId,
      part,
      submittedBy: admin.userId,
      cells,
    });
    // 행동 이력: [개설 신청] 로그(best-effort, 실행자 소속 기준). 실패해도 신청 저장 무영향.
    await insertExperienceOpeningLog({
      action: "apply",
      draftId: null,
      weekId,
      organizationSlug: organization,
      targetUserId: null,
      changedBy: admin.userId,
    });
    return Response.json({ success: true, data: result }, { status: 201 });
  } catch (error) {
    // 안전장치(테스트 스코프 위반 등)는 error.status(422 등) 를 그대로 응답.
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/experience/part-input POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "신청 저장에 실패했습니다",
      },
      { status },
    );
  }
}

export async function DELETE(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const sp = request.nextUrl.searchParams;
  const organization = sp.get("organization")?.trim() || "";
  const weekId = sp.get("week_id")?.trim() || "";
  const teamId = sp.get("team_id")?.trim() || "";
  const part = sp.get("part")?.trim() || "";

  if (!organization || !weekId || !teamId || !part) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, part 는 필수입니다" },
      { status: 400 },
    );
  }

  try {
    const result = await deletePartSubmission(organization, weekId, teamId, part);
    // 행동 이력: [신청 취소] 로그(개설 취소와 다른 이벤트). best-effort.
    await insertExperienceOpeningLog({
      action: "apply_cancel",
      draftId: null,
      weekId,
      organizationSlug: organization,
      targetUserId: null,
      changedBy: admin.userId,
    });
    return Response.json({ success: true, data: result });
  } catch (error) {
    console.error("[admin/cluster4/experience/part-input DELETE]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "신청 취소에 실패했습니다",
      },
      { status: 500 },
    );
  }
}
