import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";
import {
  EditWindowError,
  evaluateEditWindowPermission,
  getEditWindowForUser,
} from "@/lib/adminEditWindowsData";
import { isEditableResourceKey } from "@/lib/adminEditWindowsTypes";

export async function GET(request: NextRequest) {
  const resourceKey = request.nextUrl.searchParams.get("resource_key") ?? "";
  if (!isEditableResourceKey(resourceKey)) {
    return Response.json(
      { success: false, error: `Unknown resource_key: ${resourceKey || "(missing)"}` },
      { status: 400 },
    );
  }

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
    const window = userId
      ? await getEditWindowForUser(userId, resourceKey)
      : null;
    const permission = evaluateEditWindowPermission(resourceKey, window, {
      isAdmin,
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
