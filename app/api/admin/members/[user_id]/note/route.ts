import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  ADMIN_WRITE_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { getMemberDisplayName } from "@/lib/adminCrewData";
import { getCrewNote, upsertCrewNote } from "@/lib/adminCrewManagementNotes";
import { assertUserInRequestScope } from "@/lib/userScope";
import { publicErrorMessage } from "@/lib/apiError";

// 클럽 관리 기록(관리자 메모) — 조회/저장. 사용자당 1행 upsert. snapshot 무접촉.
//   GET  /api/admin/members/[user_id]/note  → 마지막 저장 메모
//   PUT  /api/admin/members/[user_id]/note  → { note } upsert (저장 버튼)
type Ctx = { params: Promise<{ user_id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;
  try {
    await assertUserInRequestScope(request, user_id);
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(
          error,
          (error as { status?: number }).status ?? 422,
          "현재 모드에서 접근할 수 없는 사용자입니다.",
        ),
      },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }
  try {
    const note = await getCrewNote(user_id);
    return Response.json({ success: true, data: note });
  } catch (error) {
    console.error("[admin/members/:user_id/note GET]", error);
    return Response.json(
      { success: false, error: "메모를 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }

  const note = (body as { note?: unknown })?.note;
  if (typeof note !== "string") {
    return Response.json(
      { success: false, error: "note(string) is required" },
      { status: 400 },
    );
  }
  try {
    await assertUserInRequestScope(request, user_id, {
      bodyMode: (body as { mode?: unknown } | null)?.mode,
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(
          error,
          (error as { status?: number }).status ?? 422,
          "현재 모드에서 접근할 수 없는 사용자입니다.",
        ),
      },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  try {
    // 존재하지 않는 user_id 에 메모 행을 만들지 않도록 가드(FK 위반 전 방어).
    const exists = await getMemberDisplayName(user_id);
    if (!exists) {
      return Response.json({ success: false, error: "대상 크루를 찾을 수 없습니다." }, { status: 404 });
    }
    const saved = await upsertCrewNote(user_id, note, admin.userId);
    return Response.json({ success: true, data: saved });
  } catch (error) {
    console.error("[admin/members/:user_id/note PUT]", error);
    return Response.json(
      { success: false, error: "메모를 저장하지 못했습니다." },
      { status: 500 },
    );
  }
}
