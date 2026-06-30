import { NextRequest } from "next/server";
import {
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import {
  EditWindowError,
  closeEditWindowsBulk,
  listMatchingEditWindowUserIds,
  upsertEditWindowsBulk,
} from "@/lib/adminEditWindowsData";
import {
  affectsWeeklyCardsCanEdit,
  isEditableResourceKey,
} from "@/lib/adminEditWindowsTypes";
import { markWeeklyCardsSnapshotStaleMany } from "@/lib/cluster4WeeklyCardsSnapshot";
import { readScopeMode } from "@/lib/userScopeShared";
import { resolveUserScope } from "@/lib/userScope";

function parseUserIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is string => typeof value === "string");
}

function parseNote(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  return trimmed.length ? trimmed : null;
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
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { success: false, error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const input = body as Record<string, unknown>;
  const resourceKey = typeof input.resource_key === "string" ? input.resource_key : "";
  if (!isEditableResourceKey(resourceKey)) {
    return Response.json(
      { success: false, error: `Unknown resource_key: ${resourceKey || "(missing)"}` },
      { status: 400 },
    );
  }

  const weekId =
    typeof input.week_id === "string" && input.week_id.trim()
      ? input.week_id.trim()
      : null;

  // ?mode=test → QA 쓰기 스코프(테스트 유저만). 미지정=operating(실사용자만). QA 누수 차단.
  const mode = readScopeMode(request.nextUrl.searchParams);

  try {
    let userIds = parseUserIds(input.user_ids);
    if (input.select_all_matching === true) {
      const filters = input.filters && typeof input.filters === "object"
        ? (input.filters as Record<string, unknown>)
        : {};
      userIds = await listMatchingEditWindowUserIds({
        resourceKey,
        query: typeof filters.q === "string" ? filters.q : null,
        mode, // select-all 모집단도 scope 한정
      });
    }

    userIds = Array.from(new Set(userIds));
    if (userIds.length === 0) {
      return Response.json(
        { success: false, error: "No user_ids selected" },
        { status: 400 },
      );
    }

    // 쓰기 스코프 가드(fail-closed) — 명시 user_ids 경로도 전원 모드 스코프에 속해야(실사용자 write 차단).
    const scope = await resolveUserScope(mode === "test" ? "test" : "operating", null);
    const outOfScope = userIds.filter((id) => !scope.includes(id));
    if (outOfScope.length > 0) {
      return Response.json(
        { success: false, error: `대상 ${outOfScope.length}명이 현재 모드(${mode}) 스코프 밖입니다. QA 모드는 테스트 유저만, 운영 모드는 실사용자만 일괄 처리할 수 있습니다.` },
        { status: 422 },
      );
    }

    if (input.action === "close") {
      const windows = await closeEditWindowsBulk(userIds, resourceKey, weekId);
      // 허브 작성기간 일괄 닫기 → 대상자 snapshot 일괄 stale (canEdit 버튼 반영).
      if (affectsWeeklyCardsCanEdit(resourceKey)) {
        await markWeeklyCardsSnapshotStaleMany(userIds);
      }
      return Response.json({
        success: true,
        data: { count: userIds.length, windows },
      });
    }

    if (typeof input.opened_at !== "string" || typeof input.expires_at !== "string") {
      return Response.json(
        { success: false, error: "opened_at and expires_at are required strings" },
        { status: 400 },
      );
    }

    const windows = await upsertEditWindowsBulk({
      userIds,
      resourceKey,
      weekId,
      openedAt: new Date(input.opened_at),
      expiresAt: new Date(input.expires_at),
      note: parseNote(input.note),
      grantedBy: admin.userId ?? null,
    });

    if (affectsWeeklyCardsCanEdit(resourceKey)) {
      await markWeeklyCardsSnapshotStaleMany(userIds);
    }

    return Response.json({
      success: true,
      data: { count: userIds.length, windows },
    });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/edit-windows/bulk POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to bulk update edit windows",
      },
      { status: 500 },
    );
  }
}
