import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  EMPTY_PART_INPUT_LINE_OPTIONS,
  EXPERIENCE_PART_LINE_TYPES,
  TEAM_OVERALL,
  isExperiencePartLineType,
  experienceScoreState,
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
import { buildLineIdCategoryMap, listExperienceLineOptions } from "@/lib/adminExperienceLineData";
import { loadOpenedLineMasterByUserCategory } from "@/lib/adminExperienceTeamOverall";
import { insertExperienceOpeningLog } from "@/lib/adminExperienceOpeningLogs";
import { parseScopeMode } from "@/lib/userScope";
import {
  assertImpersonationCapability,
  resolveEffectiveActorUserId,
  resolveImpersonation,
  resolveTeamNameById,
} from "@/lib/experienceImpersonation";

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
  const mode = parseScopeMode(sp.get("mode"));
  const actAsTestUserId = sp.get("actAsTestUserId")?.trim() || null;

  try {
    // 임퍼소네이션: mode=test + test_user_markers 유저일 때만 actor 를 그 유저로 치환.
    //   operating·실유저·빈값 → 비활성(실제 admin 컨텍스트 유지). requireAdmin 은 위에서 통과.
    const { effectiveUserId, impersonation } = await resolveEffectiveActorUserId(
      admin.userId,
      { mode, actAsTestUserId },
    );
    const actorRaw = await resolveActorContext(effectiveUserId);
    const defaultPart =
      actorRaw.role === "part_leader" && actorRaw.partName
        ? actorRaw.partName
        : TEAM_OVERALL;
    const actor = {
      ...actorRaw,
      defaultPart,
      impersonating: impersonation.active,
      impersonatedUserId: impersonation.active ? impersonation.userId : null,
    };

    // 팀 미선택이면 파트/크루 없이 actor 기본값만(클라가 팀 선택 후 재조회).
    if (!organization || !teamName) {
      const data: PartInputGetData = {
        actor,
        lines: EXPERIENCE_PART_LINE_TYPES,
        parts: [],
        crews: [],
        cells: [],
        lineOptions: EMPTY_PART_INPUT_LINE_OPTIONS,
        submitted: false,
        aggregate: null,
      };
      return Response.json({ success: true, data });
    }

    // 라인명 드롭다운 옵션(유형별) — org+공통 활성 라인. 개설신청/검수/검증 공용 단일 원천.
    const [parts, lineOptions] = await Promise.all([
      listTeamParts(organization, teamName, mode),
      listExperienceLineOptions(organization),
    ]);

    // 팀 총괄(집계, 읽기 전용).
    if (part === TEAM_OVERALL) {
      const aggregate =
        weekId && teamId
          ? await getTeamOverall(organization, weekId, teamId, teamName, mode)
          : { parts: [] };
      const data: PartInputGetData = {
        actor,
        lines: EXPERIENCE_PART_LINE_TYPES,
        parts,
        crews: [],
        cells: [],
        lineOptions,
        submitted: false,
        aggregate,
      };
      return Response.json({ success: true, data });
    }

    // 특정 파트 — 평가 대상 크루 + 저장된 셀 + 신청 상태.
    const crews = part ? await listPartCrews(organization, teamName, part, mode) : [];
    const sub =
      part && weekId && teamId
        ? await getPartSubmission(organization, weekId, teamId, part)
        : { submitted: false, cells: [] };
    // 표시 전용 fallback(팀 총괄 보드와 동일 로직 공유) — 셀 selected_line_id 가 없을 때 실제 배정·개설된
    //   라인(line_targets)으로 라인명을 채운다. 저장값 우선(미덮음). 개설 전 주차는 배정 라인이 없어 no-op.
    //   저장·신청 저장/개설 판정과 무관(GET 조회 표시만). operating/test·org 동일 경로.
    let cells = sub.cells;
    if (weekId && teamId && sub.cells.length > 0) {
      const assigned = await loadOpenedLineMasterByUserCategory(
        weekId,
        teamId,
        buildLineIdCategoryMap(lineOptions),
      );
      if (assigned.size > 0) {
        cells = sub.cells.map((c) => {
          if (c.selectedLineId) return c; // 저장된 선택값 우선.
          const fallback = assigned.get(`${c.crewUserId}::${c.lineType}`);
          return fallback ? { ...c, selectedLineId: fallback } : c;
        });
      }
    }
    const data: PartInputGetData = {
      actor,
      lines: EXPERIENCE_PART_LINE_TYPES,
      parts,
      crews,
      cells,
      lineOptions,
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
  const mode = parseScopeMode(typeof b.mode === "string" ? b.mode : null);
  const actAsTestUserId = typeof b.actAsTestUserId === "string" ? b.actAsTestUserId.trim() || null : null;

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
    const scoreState = experienceScoreState(cell.score);
    // 선택 라인 ID(빈 문자열/미지정 = null). 보이드 규칙/유형 검증은 savePartSubmission 이 담당.
    const selectedLineId =
      typeof cell.selectedLineId === "string" && cell.selectedLineId.trim()
        ? cell.selectedLineId.trim()
        : null;
    cells.push({
      crewUserId,
      lineType,
      checked: scoreState.checked,
      score: scoreState.score,
      selectedLineId,
    });
  }

  try {
    // 임퍼소네이션 write 가드(Phase C) — mode=test + 유효 테스트 유저일 때만.
    //   part_save: part_leader=자기 팀+파트 / team_leader=자기 팀 / agent·member=불가.
    //   targetTeamName 은 team_id 에서 권위 있게 해석(클라 team_name 신뢰 안 함). write 전 403 차단.
    const impersonation = await resolveImpersonation({ mode, actAsTestUserId });
    if (impersonation.active && impersonation.userId) {
      const actor = await resolveActorContext(impersonation.userId);
      const targetTeamName = await resolveTeamNameById(teamId);
      assertImpersonationCapability({
        active: true,
        actor: { memberRole: actor.memberRole, teamName: actor.teamName, partName: actor.partName },
        action: "part_save",
        targetTeamName,
        targetPart: part,
      });
    }

    const result = await savePartSubmission({
      organization,
      weekId,
      teamId,
      part,
      submittedBy: admin.userId,
      cells,
      mode,
    });
    // 행동 이력: [개설 신청] 로그(best-effort). 실패해도 신청 저장 무영향.
    //   실행자 = 임퍼소네이션 유효 시 그 테스트 유저(파트장), 아니면 실 admin. 파트 단위 → 파트명.
    await insertExperienceOpeningLog({
      action: "apply",
      weekId,
      organizationSlug: organization,
      actorUserId:
        impersonation.active && impersonation.userId
          ? impersonation.userId
          : admin.userId,
      teamId,
      partName: part,
      isTeamLevel: false,
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
  // 로그 실행자 해석용(POST 와 동일 규칙) — mode=test + 유효 테스트 유저면 그 파트장을 실행자로.
  const mode = parseScopeMode(sp.get("mode"));
  const actAsTestUserId = sp.get("actAsTestUserId")?.trim() || null;

  if (!organization || !weekId || !teamId || !part) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, part 는 필수입니다" },
      { status: 400 },
    );
  }

  try {
    const result = await deletePartSubmission(organization, weekId, teamId, part);
    // 행동 이력: [신청 취소] 로그(개설 취소와 다른 이벤트). best-effort.
    //   실행자 = 임퍼소네이션 유효 시 그 테스트 유저(파트장), 아니면 실 admin. 파트 단위 → 파트명.
    const impersonation = await resolveImpersonation({ mode, actAsTestUserId });
    await insertExperienceOpeningLog({
      action: "apply_cancel",
      weekId,
      organizationSlug: organization,
      actorUserId:
        impersonation.active && impersonation.userId
          ? impersonation.userId
          : admin.userId,
      teamId,
      partName: part,
      isTeamLevel: false,
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
