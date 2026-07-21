import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
  type AdminContext,
} from "@/lib/adminAuth";
import { guardAdminOrgAccess } from "@/lib/adminOrgAccess";
import { isOrganizationSlug } from "@/lib/organizations";
import { readScopeMode } from "@/lib/userScopeShared";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getTeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import {
  validateWeekPositionRows,
  POSITION_CODE_VALUES,
  type PositionDraftRow,
} from "@/lib/teamWeekPositionValidation";
import type { PositionCode } from "@/lib/positionHistory";

// 팀 상세 [B] — 주차별 파트/클래스 저장(관리자 override, batch).
//   PATCH ?mode=test  body { organization, weekId, rawTeam, changes:[{userId, rawPart, positionCode}] }
//     · cluster4_team_week_position_overrides upsert(conflict = user_id,week_start_date,organization,raw_team).
//     · UPH 원본 무변경 — override 만 생성/갱신. effective = override ?? UPH.
//   서버 검증(우회 방지): 검수 완료 주차 차단(403) · positionCode 화이트리스트 · 팀 전체 next 상태로
//     파트장≤1/파트 · 심화≤정규 · <운용>파트(배정 크루≥1 distinct rawPart, '일반' 포함)≤6
//     (validateWeekPositionRows — 클라이언트 onCellChange 와 동일 순수 함수). 1단계 snapshot invalidate 미호출(#27).
export async function PATCH(request: NextRequest) {
  let admin: AdminContext;
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
    return Response.json({ success: false, error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }
  const { organization, weekId, rawTeam, changes } = (body ?? {}) as {
    organization?: unknown;
    weekId?: unknown;
    rawTeam?: unknown;
    changes?: unknown;
  };

  if (typeof organization !== "string" || !isOrganizationSlug(organization)) {
    return Response.json({ success: false, error: "유효한 organization 이 필요합니다." }, { status: 400 });
  }
  const denied = await guardAdminOrgAccess(admin, organization);
  if (denied) return denied;
  if (typeof weekId !== "string" || !weekId.trim()) {
    return Response.json({ success: false, error: "weekId 가 필요합니다." }, { status: 400 });
  }
  if (typeof rawTeam !== "string" || !rawTeam.trim()) {
    return Response.json({ success: false, error: "rawTeam 이 필요합니다." }, { status: 400 });
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    return Response.json({ success: false, error: "변경 사항이 없습니다." }, { status: 400 });
  }

  // 변경 파싱 + 값 검증.
  const parsed: PositionDraftRow[] = [];
  for (const c of changes as unknown[]) {
    const { userId, rawPart, positionCode } = (c ?? {}) as {
      userId?: unknown;
      rawPart?: unknown;
      positionCode?: unknown;
    };
    if (typeof userId !== "string" || !userId) {
      return Response.json({ success: false, error: "userId 가 올바르지 않습니다." }, { status: 400 });
    }
    if (typeof positionCode !== "string" || !POSITION_CODE_VALUES.includes(positionCode as PositionCode)) {
      return Response.json(
        { success: false, error: "positionCode 는 정규/심화(에이전트/파트장)만 가능합니다." },
        { status: 400 },
      );
    }
    const part = typeof rawPart === "string" ? rawPart.trim() : "";
    if (!part) {
      return Response.json({ success: false, error: "소속 파트를 선택하세요." }, { status: 400 });
    }
    parsed.push({ userId, rawPart: part, positionCode: positionCode as PositionCode });
  }

  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    // 현재 effective 상태를 다시 읽어 검증(우회 방지). week meta + crewRows 를 그대로 사용.
    const summary = await getTeamSelectedWeekSummary({
      organization,
      teamName: rawTeam,
      weekId,
      mode,
    });
    if (!summary.week) {
      return Response.json({ success: false, error: "주차를 찾을 수 없습니다." }, { status: 404 });
    }
    if (summary.week.reviewCompleted) {
      return Response.json(
        { success: false, error: "검수가 완료된 주차는 수정할 수 없습니다." },
        { status: 403 },
      );
    }
    const weekStart = summary.week.weekStartDate;

    // next 상태 = 현재 팀 crew 행 + 변경 적용. 변경 대상은 반드시 현재 팀 crew.
    const draft = new Map<string, PositionDraftRow>();
    for (const r of summary.crewRows)
      draft.set(r.userId, { userId: r.userId, rawPart: r.rawPart, positionCode: r.positionCode });
    for (const c of parsed) {
      if (!draft.has(c.userId)) {
        return Response.json(
          { success: false, error: "현재 팀·주차의 크루가 아닌 대상은 수정할 수 없습니다." },
          { status: 400 },
        );
      }
      draft.set(c.userId, c);
    }
    const verdict = validateWeekPositionRows([...draft.values()]);
    if (!verdict.ok) {
      return Response.json({ success: false, error: verdict.message }, { status: 422 });
    }

    // 변경 행만 override upsert(원본 UPH 무변경).
    const actor = admin.email ?? admin.userId;
    const rows = parsed.map((c) => ({
      user_id: c.userId,
      organization,
      week_id: weekId,
      week_start_date: weekStart,
      raw_team: rawTeam,
      raw_part: c.rawPart,
      position_code: c.positionCode,
      created_by: actor,
      updated_by: actor,
    }));
    const { error } = await supabaseAdmin
      .from("cluster4_team_week_position_overrides")
      .upsert(rows, { onConflict: "user_id,week_start_date,organization,raw_team" });
    if (error) throw new Error(error.message);

    return Response.json({ success: true, data: { saved: rows.length } });
  } catch (error) {
    console.error("[admin/team-parts/info/team-detail/week-position PATCH]", error);
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "저장에 실패했습니다." },
      { status: 500 },
    );
  }
}
