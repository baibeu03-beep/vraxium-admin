import { NextRequest } from "next/server";
import { requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import {
  AccountsError,
  updateAccount,
  type UpdateAccountPayload,
} from "@/lib/adminAccountsData";
import { publicErrorMessage } from "@/lib/apiError";

const SUPER_ADMIN_ROLES = ["owner"] as const;

type Ctx = { params: Promise<{ user_id: string }> };

// PATCH /api/admin/accounts/[user_id]
// body: UpdateAccountPayload (role/status/organization_slug/display_name/contact_email/reason)
// → user_profiles + admin_users sync + user_role_audit 처리. super_admin 단독.
//
//   role 이 super_admin 에서 그 외 로 바뀌거나, super_admin 본인이 inactive 가 되는
//   경우 데이터 레이어가 마지막 활성 super_admin 가드를 적용한다 (409 반환).
export async function PATCH(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(SUPER_ADMIN_ROLES);
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
    return Response.json(
      { success: false, error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { success: false, error: "요청 형식이 올바르지 않습니다." },
      { status: 400 },
    );
  }

  try {
    const account = await updateAccount({
      userId: user_id,
      payload: body as UpdateAccountPayload,
      actorId: admin.userId,
    });
    return Response.json({ success: true, data: { account } });
  } catch (error) {
    console.error("[admin/accounts/:user_id PATCH]", error);
    const status = error instanceof AccountsError ? error.status : 500;
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, status, "계정 정보를 수정하지 못했습니다."),
      },
      { status },
    );
  }
}
