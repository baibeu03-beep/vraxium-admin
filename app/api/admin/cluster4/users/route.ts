import { NextRequest } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { excludeSuperAdmins } from "@/lib/superAdmins";

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  profile_photo_url: string | null;
  organization_slug: string | null;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const org = request.nextUrl.searchParams.get("organization")?.trim() || null;

  try {
    // ─────────────────────────────────────────────────────────────────────
    // [클럽 스코핑 갭 — 2026-05-29 보고]
    //   요구사항: 운영자는 본인이 속한 클럽의 크루만 조회/선택 가능해야 한다.
    //   현황: admin_users / AdminContext 에 운영자→클럽(organization_slug · club_id)
    //         매핑 컬럼이 없어, 서버 사이드에서 운영자 소속 클럽을 알 수 없다.
    //         → 정확한 서버 강제 스코핑이 현재 불가능.
    //   결정(사용자 승인): 이번 작업에서는 구현하지 않고 갭으로만 보고. 기존 조회 방식 유지.
    //         프론트 org 파라미터 방식은 보안 강제가 아니므로 채택하지 않는다.
    //   향후: admin_users 에 운영자-클럽 매핑이 확정되면 아래 위치에서 강제 필터를 추가한다:
    //         const admin = await requireAdmin(...);  // org 포함하도록 확장
    //         query = query.eq("organization_slug", admin.organizationSlug);
    //   (아래 `org` 쿼리 필터는 임시 편의용이며, 운영자 소속 강제와는 무관하다.)
    // ─────────────────────────────────────────────────────────────────────
    let query = supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,profile_photo_url,organization_slug")
      .order("display_name", { ascending: true });

    // super admin 은 라인/허브 멤버 선택 목록에서 제외 (목록 노출에서만 숨김).
    query = excludeSuperAdmins(query);

    if (org) {
      query = query.eq("organization_slug", org);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[admin/cluster4/users GET] query error", error);
      return Response.json(
        { success: false, error: error.message },
        { status: 500 },
      );
    }

    const users = ((data ?? []) as UserProfileRow[]).map((u) => ({
      userId: u.user_id,
      displayName: u.display_name ?? "(이름 없음)",
      profileImg: u.profile_photo_url,
      organization: u.organization_slug,
    }));

    return Response.json({ success: true, data: users });
  } catch (error) {
    console.error("[admin/cluster4/users GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to list users",
      },
      { status: 500 },
    );
  }
}
