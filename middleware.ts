import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { toSessionCookieOptions } from "@/lib/sessionCookieOptions";

// Refresh the Supabase auth cookies on every request so server-rendered pages
// and route handlers see a non-expired session. This is the canonical
// @supabase/ssr middleware pattern — do NOT add custom logic between
// `createServerClient` and `getUser()`, otherwise the refresh-on-read contract
// breaks. Page-level access control lives in `requireAdmin` / `requireAdminPage`.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            // Session cookies: drop maxAge/expires so the refreshed auth cookies
            // end on browser close. See lib/sessionCookieOptions.ts.
            response.cookies.set(name, value, toSessionCookieOptions(options));
          }
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Skip static assets, the Next.js internals, and image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
