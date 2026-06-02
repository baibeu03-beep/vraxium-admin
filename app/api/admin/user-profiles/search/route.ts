// app/api/admin/user-profiles/search/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { excludeSuperAdmins } from "@/lib/superAdmins";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();

  if (!q) {
    return NextResponse.json({ users: [] });
  }

  let query = supabaseAdmin
    .from("user_profiles")
    .select("user_id, auth_email, contact_email, name, organization")
    .limit(20);

  // super admin 은 검색/자동완성 결과에서 제외 (목록 노출에서만 숨김).
  query = excludeSuperAdmins(query);

  if (UUID_RE.test(q)) {
    query = query.eq("user_id", q);
  } else {
    query = query.or(
      [
        `auth_email.ilike.%${q}%`,
        `contact_email.ilike.%${q}%`,
        `name.ilike.%${q}%`,
        `organization.ilike.%${q}%`,
      ].join(","),
    );
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ users: data ?? [] });
}
