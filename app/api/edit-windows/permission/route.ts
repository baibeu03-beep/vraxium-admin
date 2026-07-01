import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  EditWindowError,
  evaluateEditWindowPermission,
  getEditWindowForUser,
} from "@/lib/adminEditWindowsData";
import {
  isEditableResourceKey,
  isWeekScopedResourceKey,
} from "@/lib/adminEditWindowsTypes";

export async function GET(request: NextRequest) {
  const resourceKey = request.nextUrl.searchParams.get("resource_key") ?? "";
  if (!isEditableResourceKey(resourceKey)) {
    return Response.json(
      { success: false, error: `Unknown resource_key: ${resourceKey || "(missing)"}` },
      { status: 400 },
    );
  }

  // 주간 자원(주간 회고/동료/평판)은 반드시 현재 보고 있는 주차의 week_id 를 함께
  // 받아야 한다. 프론트 크루 페이지는 카드의 weekId 를 ?week_id 로 전달한다.
  const requiresWeek = isWeekScopedResourceKey(resourceKey);
  const weekId =
    request.nextUrl.searchParams.get("week_id")?.trim() || null;

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json(
      { success: false, error: "Authentication required." },
      { status: 401 },
    );
  }

  const { data: adminRow, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("id,is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (adminError) {
    return Response.json(
      { success: false, error: adminError.message },
      { status: 500 },
    );
  }

  const isAdmin = Boolean(
    adminRow && (adminRow as { is_active: boolean | null }).is_active,
  );
  const userId = await resolveProfileUserId(user.id, user.email);

  try {
    // 주간 자원인데 week_id 가 없으면 조회 자체를 건너뛰고 week_required 로 막는다.
    const window =
      userId && !(requiresWeek && !weekId)
        ? await getEditWindowForUser(userId, resourceKey, weekId)
        : null;
    const permission = evaluateEditWindowPermission(resourceKey, window, {
      isAdmin,
      requiresWeek,
      weekId,
    });
    return Response.json({ success: true, data: permission });
  } catch (error) {
    if (error instanceof EditWindowError) {
      return Response.json(
        { success: false, error: error.message },
        { status: error.status },
      );
    }
    console.error("[edit-windows/permission GET]", error);
    return Response.json(
      { success: false, error: "Failed to resolve edit permission" },
      { status: 500 },
    );
  }
}
