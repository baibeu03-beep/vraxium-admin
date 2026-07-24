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
import {
  hasPriorExperiencePartApplicationLog,
  insertExperienceOpeningLog,
} from "@/lib/adminExperienceOpeningLogs";
import { resolveExperienceApplicationLogAction } from "@/lib/experienceOpeningLogFormat";
import {
  cancelOverallReviewForDataChange,
  loadOverallReviewState,
} from "@/lib/adminExperienceReviewReset";
import {
  hasPartSubmissionChanges,
  REVIEW_RESET_CONFIRM_CODE,
  REVIEW_RESET_CONFIRM_MESSAGE,
} from "@/lib/experienceReviewResetPolicy";
import { parseScopeMode } from "@/lib/userScope";
import {
  assertImpersonationCapability,
  resolveEffectiveActorUserId,
  resolveImpersonation,
  resolveTeamNameById,
} from "@/lib/experienceImpersonation";
import { publicErrorMessage } from "@/lib/apiError";

// 실무 경험 파트장 입력 그리드 — 신청 데이터(신규 전용 저장) API.
//   GET    ?organization=&week_id=&team_id=&team_name=&part=  → 파트/크루/셀/신청상태 (+actor 기본값)
//   POST   { organization, week_id, team_id, team_name, part, cells[], confirmReviewReset? }
//                                                             → 신청 저장(upsert) [+ 개설 검수 취소]
//   DELETE ?organization=&week_id=&team_id=&part=[&confirmReviewReset=1]
//                                                             → 신청 취소(헤더 삭제, 셀 cascade) [+ 개설 검수 취소]
//
// ⚠ 기존 experience_drafts/개설/snapshot 무연동. demo/일반 동일(org 스코프, demoUserId 미사용).
//
// [개설 검수 취소 게이트](2026-07-23) — mode/org/임퍼소네이션 무관 동일 로직·동일 DTO.
//   이미 [개설 검수](status='reviewed')가 끝난 팀·주차에서 파트 신청 데이터가 **실제로 바뀌면**,
//   확인 없이 저장하지 않는다. 서버가 저장 전 diff 를 판정해 409(code=REVIEW_RESET_CONFIRM_CODE)로
//   되돌려 화면이 확인 팝업을 띄우게 하고, confirmReviewReset=true 재요청에서만
//   [저장 → 검수 취소] 순서로 처리한다.
//     · 변경 없음 → 팝업 없음·검수 상태 유지(기존 저장 동작 그대로).
//     · 저장 실패 → 검수 취소 미실행(저장 성공 이후에만 취소한다 — 순서가 원자성 보장의 핵심).
//     · status='opened'(개설 완료) → 대상 아님. 고객 반영 원복은 [개설 취소]가 담당.

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
        error: publicErrorMessage(error, 500, "파트 입력 데이터를 불러오지 못했습니다"),
      },
      { status: 500 },
    );
  }
}

// 저장/삭제가 성공한 **뒤** 검수 취소를 시도한다.
//   취소 UPDATE 자체가 실패해도 이미 끝난 저장을 되돌리지 않는다(요구사항: 저장 실패 시에만 검수 유지).
//   대신 reviewResetFailed=true 로 알려 화면이 "저장됨 + 검수 취소 실패"를 정확히 안내하게 한다.
//   — 성공 응답에 "검수 취소 실패"를 숨기지 않는다.
async function applyReviewReset(input: {
  needed: boolean;
  organization: string;
  weekId: string;
  teamId: string;
  teamName?: string | null;
  actorUserId: string | null;
  partName: string;
}): Promise<{ reviewReset: boolean; reviewResetFailed: boolean }> {
  if (!input.needed) return { reviewReset: false, reviewResetFailed: false };
  try {
    const reset = await cancelOverallReviewForDataChange({
      organization: input.organization,
      weekId: input.weekId,
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      actorUserId: input.actorUserId,
      partName: input.partName,
    });
    return { reviewReset: reset, reviewResetFailed: false };
  } catch (error) {
    console.error("[admin/cluster4/experience/part-input] review reset failed", error);
    return { reviewReset: false, reviewResetFailed: true };
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
  // 검수 취소 확인 여부(화면 팝업 [확인]). 미지정=false → 변경 감지 시 409 로 확인을 요구한다.
  const confirmReviewReset = b.confirmReviewReset === true;
  // 로그 표기용(팀명은 team_id 로 권위 해석되므로 없어도 무방).
  const teamName = typeof b.team_name === "string" ? b.team_name.trim() : "";

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

    const actorUserId =
      impersonation.active && impersonation.userId
        ? impersonation.userId
        : admin.userId;

    // ── 개설 검수 취소 게이트(저장 전 판정) ──
    //   ① 저장된 신청과 이번 요청이 실제로 다른가(정규화 후 비교 — 그리드 소유 셀만).
    //   ② 다르고 그 팀·주차가 검수 완료 상태면 확인(confirmReviewReset) 없이는 저장하지 않는다.
    //   변경이 없으면 상태 조회조차 하지 않는다 — 검수 상태는 그대로 유지된다.
    const storedSubmission = await getPartSubmission(organization, weekId, teamId, part);
    // 신청 취소로 헤더가 삭제된 뒤의 재신청도 구분하기 위해 구조화된 과거 apply/reapply 이력을 확인한다.
    // 현재 헤더가 있으면 이미 재신청이 확정되므로 불필요한 로그 조회는 생략한다.
    const hadPriorApplicationLog =
      storedSubmission.submitted ||
      (await hasPriorExperiencePartApplicationLog({
        weekId,
        organizationSlug: organization,
        teamId,
        partName: part,
      }));
    const changed = hasPartSubmissionChanges({
      incoming: cells,
      stored: storedSubmission.cells,
      storedHeaderExists: storedSubmission.submitted,
    });
    const reviewState = changed
      ? await loadOverallReviewState(organization, weekId, teamId)
      : null;
    const needsReviewReset = changed && reviewState?.status === "reviewed";
    if (needsReviewReset && !confirmReviewReset) {
      return Response.json(
        {
          success: false,
          error: REVIEW_RESET_CONFIRM_MESSAGE,
          code: REVIEW_RESET_CONFIRM_CODE,
        },
        { status: 409 },
      );
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

    // 저장 성공 이후에만 검수 취소(순서 = 원자성 보장). 저장이 던졌으면 여기 도달하지 않는다.
    const { reviewReset, reviewResetFailed } = await applyReviewReset({
      needed: Boolean(needsReviewReset),
      organization,
      weekId,
      teamId,
      teamName: teamName || null,
      actorUserId,
      partName: part,
    });

    // 행동 이력: mutation 직전에 읽은 신청 헤더 존재 여부로 최초 신청/재신청을 구분한다.
    //   문자열·화면 상태·mode 로 추측하지 않으며 기존 로그는 재분류하지 않는다.
    //   실패해도 신청 저장 무영향(best-effort).
    //   실행자 = 임퍼소네이션 유효 시 그 테스트 유저(파트장), 아니면 실 admin. 파트 단위 → 파트명.
    await insertExperienceOpeningLog({
      action: resolveExperienceApplicationLogAction(
        storedSubmission.submitted,
        hadPriorApplicationLog,
      ),
      weekId,
      organizationSlug: organization,
      actorUserId,
      teamId,
      partName: part,
      isTeamLevel: false,
    });
    // DTO 는 mode/org 무관 동일 — changed/reviewReset/reviewResetFailed 는 항상 존재하는 boolean.
    return Response.json(
      { success: true, data: { ...result, changed, reviewReset, reviewResetFailed } },
      { status: 201 },
    );
  } catch (error) {
    // 안전장치(테스트 스코프 위반 등)는 error.status(422 등) 를 그대로 응답.
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/experience/part-input POST]", error);
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, status, "신청 저장에 실패했습니다"),
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
  // 검수 취소 확인(POST 와 동일 규약) — 신청 취소도 검수된 데이터를 없애는 실제 변경이다.
  const confirmReviewResetRaw = sp.get("confirmReviewReset")?.trim() || "";
  const confirmReviewReset =
    confirmReviewResetRaw === "1" || confirmReviewResetRaw === "true";

  if (!organization || !weekId || !teamId || !part) {
    return Response.json(
      { success: false, error: "organization, week_id, team_id, part 는 필수입니다" },
      { status: 400 },
    );
  }

  try {
    // 개설 검수 취소 게이트(POST 와 동일 판정) — 신청이 실제로 존재할 때만 "변경"이다.
    //   이미 신청이 없으면(멱등 재호출) 검수 상태를 건드리지 않는다.
    const storedSubmission = await getPartSubmission(organization, weekId, teamId, part);
    const reviewState = storedSubmission.submitted
      ? await loadOverallReviewState(organization, weekId, teamId)
      : null;
    const needsReviewReset = reviewState?.status === "reviewed";
    if (needsReviewReset && !confirmReviewReset) {
      return Response.json(
        {
          success: false,
          error: REVIEW_RESET_CONFIRM_MESSAGE,
          code: REVIEW_RESET_CONFIRM_CODE,
        },
        { status: 409 },
      );
    }

    const result = await deletePartSubmission(organization, weekId, teamId, part);
    // 행동 이력: [신청 취소] 로그(개설 취소와 다른 이벤트). best-effort.
    //   실행자 = 임퍼소네이션 유효 시 그 테스트 유저(파트장), 아니면 실 admin. 파트 단위 → 파트명.
    const impersonation = await resolveImpersonation({ mode, actAsTestUserId });
    const actorUserId =
      impersonation.active && impersonation.userId
        ? impersonation.userId
        : admin.userId;

    // 삭제 성공 이후에만 검수 취소(POST 와 동일 순서 규약).
    const { reviewReset, reviewResetFailed } = await applyReviewReset({
      needed: Boolean(needsReviewReset),
      organization,
      weekId,
      teamId,
      actorUserId,
      partName: part,
    });

    await insertExperienceOpeningLog({
      action: "apply_cancel",
      weekId,
      organizationSlug: organization,
      actorUserId,
      teamId,
      partName: part,
      isTeamLevel: false,
    });
    return Response.json({
      success: true,
      data: { ...result, reviewReset, reviewResetFailed },
    });
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    console.error("[admin/cluster4/experience/part-input DELETE]", error);
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, status, "신청 취소에 실패했습니다"),
      },
      { status },
    );
  }
}
