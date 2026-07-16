import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  isSecondEntryEligibleLine,
  writeSecondEntryOverride,
} from "@/lib/cluster4SecondEntryOverride";
import { isCrewWeekEditable } from "@/shared/growth.contracts";

type Ctx = { params: Promise<{ user_id: string; week_id: string; line_id: string }> };

// PATCH /api/admin/members/[user_id]/weeks/[week_id]/lines/[line_id]/second-entry
//   지정 크루·주차·라인 하나의 "2차 기입" 관리자 수동 override 를 토글한다. body: { allowed: boolean }.
//   허용(true)=클럽오픈+강화성공 라인만 force-open, 불가(false)=override 회수(언제든 가능).
//   서버 검증: 관리자 쓰기권한 + 스코프(422) + weekId 소유(404) + 확정 주차(409) + 라인 존재(404) +
//     허용 시 자격(클럽오픈·강화성공, 422). 프론트 값(라인 식별/자격)을 그대로 신뢰하지 않는다.
export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id, line_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }
  const b = body as Record<string, unknown>;
  if (typeof b.allowed !== "boolean") {
    return Response.json({ success: false, error: "allowed must be a boolean" }, { status: 400 });
  }
  const allowed = b.allowed;

  try {
    await assertUserInRequestScope(request, user_id, { bodyMode: b.mode });
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    const resolved = await resolveCrewWeekCard(user_id, week_id);
    if (!resolved.ok) {
      const message =
        resolved.reason === "member_not_found" ? "Crew not found" : "Week not found for this crew";
      return Response.json({ success: false, error: message }, { status: 404 });
    }
    const { crew, card } = resolved;

    // 권한 축: 2차 기입 override 는 확정(성장 결과 확정) 주차에서만 관리 가능(집계 전 차단).
    if (!isCrewWeekEditable(card.userWeekStatus)) {
      return Response.json(
        { success: false, error: "성장 결과가 확정된 이후에만 2차 기입을 변경할 수 있습니다." },
        { status: 409 },
      );
    }

    const line = card.lines.find((l) => l.lineId != null && l.lineId === line_id);

    if (allowed) {
      // 미오픈(클럽 미개설) — 카드에서 그 line_id 를 가진 오픈 라인을 못 찾음.
      if (!line) {
        return Response.json(
          { success: false, error: "오픈된 라인이 아니므로, 2차 기입을 허용할 수 없습니다." },
          { status: 422 },
        );
      }
      // 오픈됐지만 본인 배정 아님 / 강화 성공 아님.
      if (!isSecondEntryEligibleLine(line)) {
        return Response.json(
          {
            success: false,
            error: "오픈되었지만, 강화 성공한 라인이 아니므로 2차 기입을 허용할 수 없습니다.",
          },
          { status: 422 },
        );
      }
    }
    // 불가(회수)는 라인이 카드에 없어도 안전하게 허용(과거 비정상 허용 정리 포함) — 단 write 는 존재 행만 변경.

    const result = await writeSecondEntryOverride({
      userId: crew.userId,
      weekId: card.weekId,
      lineId: line_id,
      allowed,
      adminUserId: admin.userId,
      source: "admin_manual",
    });

    // 응답 effectiveEditable — override 반영 후 canEdit 재조회(자동 기간 또는 수동 override).
    let effectiveEditable = false;
    const after = await resolveCrewWeekCard(user_id, week_id);
    if (after.ok) {
      effectiveEditable =
        after.card.lines.find((l) => l.lineId === line_id)?.canEdit === true;
    }

    return Response.json({
      success: true,
      data: {
        lineId: line_id,
        allowed: result.allowed,
        changed: result.changed,
        effectiveEditable,
      },
    });
  } catch (error) {
    console.error("[admin/.../lines/:line_id/second-entry PATCH]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to update second entry",
      },
      { status: 500 },
    );
  }
}
