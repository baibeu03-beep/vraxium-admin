import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  isExperienceOverallCategory,
  type OverallLeaderCellDto,
  type OverallLineSelectionDto,
  type OverallOutput,
  type OverallSaveAction,
} from "@/lib/experienceTeamOverallTypes";
import { isExperiencePartLineType } from "@/lib/experiencePartInputTypes";
import {
  cancelTeamOverall,
  getTeamOverallBoard,
  openTeamOverall,
  saveTeamOverallReview,
} from "@/lib/adminExperienceTeamOverall";
import { parseScopeMode } from "@/lib/userScope";
import {
  assertImpersonationCapability,
  resolveImpersonation,
  resolveTeamNameById,
} from "@/lib/experienceImpersonation";
import { resolveActorContext } from "@/lib/adminExperiencePartInput";

// 실무 경험 [팀 총괄] — 개설 검수/완료/취소 API.
//   GET  ?organization=&week_id=&team_id=&team_name=  → 보드(파트별 크루×5열 + 아웃풋 + status + 확장)
//   POST { action: 'review'|'open'|'cancel', organization, week_id, team_id, team_name,
//          leaderCells[], outputs[] }
//
//   권한(이번 phase): review=에이전트, open/cancel=팀장 (UI/로그/데이터는 역할 구분 전제로 설계).
//   실제 차단은 ADMIN_WRITE_ROLES 공통(세부 역할 게이트는 후속). snapshot 생성/조회 무변경.

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
  const mode = parseScopeMode(sp.get("mode"));
  const actAsTestUserId = sp.get("actAsTestUserId")?.trim() || null;

  if (!organization || !weekId || !teamId || !teamName) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, team_name 는 필수입니다" },
      { status: 400 },
    );
  }

  try {
    // Phase A: actAsTestUserId 검증만(board DTO 무변경·동작 무변경). 유효 시 감사 로그.
    //   board 구성/버튼 게이팅(actor 기반)은 Phase B/C 에서 진행. write 가드 미적용.
    const impersonation = await resolveImpersonation({ mode, actAsTestUserId });
    if (impersonation.active) {
      console.info("[team-overall GET] impersonation active", {
        adminId: admin.userId,
        actAsTestUserId: impersonation.userId,
        organization,
        teamId,
      });
    }

    const data = await getTeamOverallBoard(organization, weekId, teamId, teamName, mode);
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/cluster4/experience/team-overall GET]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "팀 총괄 데이터를 불러오지 못했습니다",
      },
      { status: 500 },
    );
  }
}

function parseLeaderCells(raw: unknown): OverallLeaderCellDto[] {
  const out: OverallLeaderCellDto[] = [];
  if (!Array.isArray(raw)) return out;
  for (const c of raw) {
    const cell = c as Record<string, unknown>;
    const crewUserId = typeof cell.crewUserId === "string" ? cell.crewUserId : null;
    const category = cell.category;
    if (!crewUserId) continue;
    if (category !== "management" && category !== "extension") continue;
    const scoreNum = Number(cell.score);
    const score = Number.isFinite(scoreNum)
      ? Math.max(0, Math.min(10, Math.round(scoreNum)))
      : 0;
    const selectedLineId =
      typeof cell.selectedLineId === "string" && cell.selectedLineId.trim()
        ? cell.selectedLineId.trim()
        : null;
    out.push({
      crewUserId,
      category,
      checked: Boolean(cell.checked),
      score,
      selectedLineId,
    });
  }
  return out;
}

// 도출/분석/견문 라인명 편집 payload — part-derived 유형만 통과. selectedLineId 빈값=null.
function parseLineSelections(raw: unknown): OverallLineSelectionDto[] {
  const out: OverallLineSelectionDto[] = [];
  if (!Array.isArray(raw)) return out;
  for (const s of raw) {
    const row = s as Record<string, unknown>;
    const crewUserId = typeof row.crewUserId === "string" ? row.crewUserId : null;
    const lineType = row.lineType;
    if (!crewUserId || !isExperiencePartLineType(lineType)) continue;
    const selectedLineId =
      typeof row.selectedLineId === "string" && row.selectedLineId.trim()
        ? row.selectedLineId.trim()
        : null;
    out.push({ crewUserId, lineType, selectedLineId });
  }
  return out;
}

function parseOutputs(raw: unknown): OverallOutput[] {
  const out: OverallOutput[] = [];
  if (!Array.isArray(raw)) return out;
  for (const o of raw) {
    const row = o as Record<string, unknown>;
    const category = row.category;
    if (!isExperienceOverallCategory(category)) continue;
    out.push({
      category,
      link: typeof row.link === "string" ? row.link : "",
      description: typeof row.description === "string" ? row.description : "",
      imageUrl: typeof row.imageUrl === "string" ? row.imageUrl : "",
      imageDescription: typeof row.imageDescription === "string" ? row.imageDescription : "",
    });
  }
  return out;
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
  const action = b.action as OverallSaveAction;
  const organization = typeof b.organization === "string" ? b.organization.trim() : "";
  const weekId = typeof b.week_id === "string" ? b.week_id.trim() : "";
  const teamId = typeof b.team_id === "string" ? b.team_id.trim() : "";
  const teamName = typeof b.team_name === "string" ? b.team_name.trim() : "";
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);
  const actAsTestUserId = typeof b.actAsTestUserId === "string" ? b.actAsTestUserId.trim() || null : null;

  if (!organization || !weekId || !teamId || !teamName) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, team_name 는 필수입니다" },
      { status: 400 },
    );
  }
  if (action !== "review" && action !== "open" && action !== "cancel") {
    return Response.json(
      { success: false, error: "action 은 review|open|cancel 이어야 합니다" },
      { status: 400 },
    );
  }

  try {
    // 임퍼소네이션 write 가드(Phase C) — mode=test + 유효 테스트 유저일 때만.
    //   open/cancel: team_leader=자기 팀 / part_leader·agent=불가.
    //   review: agent·team_leader=자기 팀 / part_leader=불가. targetTeamName=team_id 권위 해석.
    const impersonation = await resolveImpersonation({ mode, actAsTestUserId });
    if (impersonation.active && impersonation.userId) {
      const actor = await resolveActorContext(impersonation.userId);
      const targetTeamName = await resolveTeamNameById(teamId);
      const gateAction = action === "open" ? "open" : action === "cancel" ? "cancel" : "review";
      assertImpersonationCapability({
        active: true,
        actor: { memberRole: actor.memberRole, teamName: actor.teamName, partName: actor.partName },
        action: gateAction,
        targetTeamName,
      });
    }

    // 로그 실행자 = 임퍼소네이션 유효 시 그 테스트 유저(에이전트/팀장), 아니면 실 admin.
    //   opened_by/reviewed_by(감사 컬럼)는 실 admin 유지 — 로그 표기 실행자만 actorId 로 분리.
    const actorId =
      impersonation.active && impersonation.userId
        ? impersonation.userId
        : admin.userId;

    if (action === "cancel") {
      const data = await cancelTeamOverall({
        organization,
        weekId,
        teamId,
        teamName,
        adminId: admin.userId,
        actorId,
      });
      return Response.json({ success: true, data });
    }

    const leaderCells = parseLeaderCells(b.leaderCells);
    const outputs = parseOutputs(b.outputs);
    const lineSelections = parseLineSelections(b.lineSelections);

    if (action === "review") {
      const data = await saveTeamOverallReview({
        organization,
        weekId,
        teamId,
        teamName,
        leaderCells,
        outputs,
        lineSelections,
        adminId: admin.userId,
        actorId,
        mode,
      });
      return Response.json({ success: true, data }, { status: 201 });
    }

    // action === "open"
    const data = await openTeamOverall({
      organization,
      weekId,
      teamId,
      teamName,
      leaderCells,
      outputs,
      lineSelections,
      adminId: admin.userId,
      actorId,
      mode,
    });
    return Response.json(
      {
        success: true,
        data,
        ...(data.warnings.length > 0 ? { warnings: data.warnings } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/experience/team-overall POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "팀 총괄 처리에 실패했습니다",
      },
      { status },
    );
  }
}
