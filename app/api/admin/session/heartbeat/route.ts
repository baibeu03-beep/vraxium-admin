import { getSupabaseServerClient } from "@/lib/supabaseServer";

// Lightweight liveness ping used by AdminSessionManager while the admin is
// actively using a page without navigating. Its sole purpose is to cause a
// server request so middleware refreshes the sliding "last activity" cookie
// (see middleware.ts). No DB lookup — just confirm a Supabase session exists.
//
// If the session has already idle-expired, middleware clears the cookies and
// short-circuits this request with a 401 before it runs.
export async function GET() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ success: false, error: "Unauthenticated" }, { status: 401 });
  }
  return new Response(null, { status: 204 });
}
