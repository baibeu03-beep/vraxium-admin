import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  denyAllSecondEntryOverridesForUserWeek,
  isSecondEntryEligibleLine,
  writeSecondEntryOverride,
} from "@/lib/cluster4SecondEntryOverride";
import { isCrewWeekEditable } from "@/shared/growth.contracts";

type Ctx = { params: Promise<{ user_id: string; week_id: string }> };

// POST /api/admin/members/[user_id]/weeks/[week_id]/lines/second-entry/bulk
//   body: { action: "allow" | "deny" }.
//   - allow: 이 주차에서 자격(클럽오픈·본인배정·강화성공) 있는 라인을 서버가 다시 도출해 모두 허용.
//     프론트가 보낸 라인 목록은 신뢰하지 않는다(§17). 나머지 상태 라인은 건드리지 않음.
//   - deny : 이 (크루,주차)의 현재 수동 허용(allowed=true) override 를 모두 닫는다(과거 비정상 허용 포함).
//   서버 검증: 관리자 쓰기권한 + 스코프(422) + weekId 소유(404) + 확정 주차(409). 멱등(재실행 0건 안전).
export async function POST(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id, week_id } = await params;

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
  if (b.action !== "allow" && b.action !== "deny") {
    return Response.json(
      { success: false, error: 'action must be "allow" or "deny"' },
      { status: 400 },
    );
  }
  const action = b.action;

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

    if (!isCrewWeekEditable(card.userWeekStatus)) {
      return Response.json(
        { success: false, error: "성장 결과가 확정된 이후에만 2차 기입을 변경할 수 있습니다." },
        { status: 409 },
      );
    }

    if (action === "allow") {
      // 서버가 자격 라인을 다시 도출(프론트 목록 불신). 오픈+본인배정+강화성공만.
      const eligibleLineIds = Array.from(
        new Set(
          card.lines
            .filter((l) => isSecondEntryEligibleLine(l) && l.lineId != null)
            .map((l) => l.lineId as string),
        ),
      );
      let changedCount = 0;
      const lines: Array<{ lineId: string; allowed: boolean }> = [];
      for (const lineId of eligibleLineIds) {
        const r = await writeSecondEntryOverride({
          userId: crew.userId,
          weekId: card.weekId,
          lineId,
          allowed: true,
          adminUserId: admin.userId,
          source: "admin_bulk",
        });
        if (r.changed) changedCount += 1;
        lines.push({ lineId, allowed: true });
      }
      return Response.json({
        success: true,
        data: {
          action,
          changedCount,
          skippedCount: eligibleLineIds.length - changedCount, // 이미 허용이던 자격 라인
          lines,
        },
      });
    }

    // deny — 이 (크루,주차)의 활성 허용 override 전량 닫기.
    const closedLineIds = await denyAllSecondEntryOverridesForUserWeek({
      userId: crew.userId,
      weekId: card.weekId,
      adminUserId: admin.userId,
    });
    return Response.json({
      success: true,
      data: {
        action,
        changedCount: closedLineIds.length,
        skippedCount: 0,
        lines: closedLineIds.map((lineId) => ({ lineId, allowed: false })),
      },
    });
  } catch (error) {
    console.error("[admin/.../lines/second-entry/bulk POST]", error);
    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to bulk update second entry",
      },
      { status: 500 },
    );
  }
}
