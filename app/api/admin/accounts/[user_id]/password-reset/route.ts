import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  AccountsError,
  resetAccountPassword,
} from "@/lib/adminAccountsData";

const SUPER_ADMIN_ROLES = ["owner"] as const;

type Ctx = { params: Promise<{ user_id: string }> };

// POST /api/admin/accounts/[user_id]/password-reset
// → Supabase auth.users 의 password 를 새 임시 비밀번호로 교체.
//   응답에 1회 노출되며, super_admin 이 사용자에게 안전한 채널로 전달해야 한다.
//   OAuth(카카오 등) 사용자에게는 의미가 없음 — UI 가 confirm 단계에서 안내.
export async function POST(_request: NextRequest, { params }: Ctx) {
  try {
    await requireAdmin(SUPER_ADMIN_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const { user_id } = await params;

  try {
    const result = await resetAccountPassword(user_id);
    return Response.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof AccountsError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[admin/accounts/:user_id/password-reset POST]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to reset password",
      },
      { status: 500 },
    );
  }
}
