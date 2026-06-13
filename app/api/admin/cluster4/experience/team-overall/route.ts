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
  type OverallOutput,
  type OverallSaveAction,
} from "@/lib/experienceTeamOverallTypes";
import {
  cancelTeamOverall,
  getTeamOverallBoard,
  openTeamOverall,
  saveTeamOverallReview,
} from "@/lib/adminExperienceTeamOverall";
import { parseScopeMode } from "@/lib/userScope";

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
  void admin;

  const sp = request.nextUrl.searchParams;
  const organization = sp.get("organization")?.trim() || "";
  const weekId = sp.get("week_id")?.trim() || "";
  const teamId = sp.get("team_id")?.trim() || "";
  const teamName = sp.get("team_name")?.trim() || "";
  const mode = parseScopeMode(sp.get("mode"));

  if (!organization || !weekId || !teamId || !teamName) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, team_name 는 필수입니다" },
      { status: 400 },
    );
  }

  try {
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
    out.push({
      crewUserId,
      category,
      checked: Boolean(cell.checked),
      score,
    });
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
    if (action === "cancel") {
      const data = await cancelTeamOverall({
        organization,
        weekId,
        teamId,
        teamName,
        adminId: admin.userId,
      });
      return Response.json({ success: true, data });
    }

    const leaderCells = parseLeaderCells(b.leaderCells);
    const outputs = parseOutputs(b.outputs);

    if (action === "review") {
      const data = await saveTeamOverallReview({
        organization,
        weekId,
        teamId,
        teamName,
        leaderCells,
        outputs,
        adminId: admin.userId,
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
      adminId: admin.userId,
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
