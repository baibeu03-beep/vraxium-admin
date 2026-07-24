import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  ADMIN_PERSIST_COOKIE,
  applyAdminSessionCookieOptions,
} from "@/lib/sessionCookieOptions";
import {
  ADMIN_IDLE_TIMEOUT_MS,
  ADMIN_LAST_ACTIVE_COOKIE,
} from "@/lib/adminSessionConfig";
import {
  decodeActivityMarker,
  encodeActivityMarker,
  isSameLogin,
} from "@/lib/adminActivityCookie";
import { decodeJwtClaims } from "@/lib/jwtClaims";

// Refresh the Supabase auth cookies on every request so server-rendered pages
// and route handlers see a non-expired session (canonical @supabase/ssr pattern
// — do NOT add custom logic between `createServerClient` and `getUser()`).
//
// On top of that this middleware enforces the *server-side* idle timeout, which
// is the source of truth for "auto-logout after N minutes of inactivity":
//   · every authenticated request stamps a sliding `admin_last_active` session
//     cookie (activity = any request the admin makes; AdminSessionManager also
//     pings a heartbeat while the user is active on a single page).
//   · if that cookie is older than ADMIN_IDLE_TIMEOUT_MS, the session is treated
//     as expired: the Supabase cookies are cleared and the request is bounced to
//     /login (pages) or answered with 401 (APIs) — so the HTTP layer behaves
//     exactly like the auth state, with or without client JS.
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  // "로그인 상태 유지" opt-in: keep the refreshed auth cookies persistent (7-day
  // window) instead of session cookies. Idle auto-logout below is unaffected.
  const persistSession =
    request.cookies.get(ADMIN_PERSIST_COOKIE)?.value === "1";

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
            // Default: session cookies (end on browser close). With the "keep me
            // signed in" opt-in: persistent 7-day cookies. See
            // lib/sessionCookieOptions.ts.
            response.cookies.set(
              name,
              value,
              applyAdminSessionCookieOptions(options, persistSession),
            );
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const now = Date.now();
    const stored = decodeActivityMarker(
      request.cookies.get(ADMIN_LAST_ACTIVE_COOKIE)?.value,
    );

    // Identify the CURRENT login so a stale activity marker from a *previous*
    // session cannot idle-expire a session that was just re-established. The
    // access token's `session_id` is stable across refreshes within one login
    // and changes on a new sign-in; `iat` is the fallback for legacy markers.
    // getUser() above already verified the token — getSession() here is a local
    // cookie read (no network) used only for these bookkeeping claims.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const claims = decodeJwtClaims(session?.access_token);
    const currentSessionId =
      typeof claims?.session_id === "string" ? claims.session_id : null;
    const currentIssuedAtMs =
      typeof claims?.iat === "number" ? claims.iat * 1000 : null;

    if (stored) {
      const sameLogin = isSameLogin(stored, currentSessionId, currentIssuedAtMs);
      const idleExpired =
        sameLogin && now - stored.timestampMs > ADMIN_IDLE_TIMEOUT_MS;

      if (idleExpired) {
        return buildIdleLogoutResponse(request);
      }
    }

    // Slide the activity window forward, keyed to the current login. Session
    // cookie (no maxAge) so it also dies on full browser close; idle is enforced
    // by comparing timestamps for the *same* session.
    response.cookies.set(
      ADMIN_LAST_ACTIVE_COOKIE,
      encodeActivityMarker(now, currentSessionId),
      {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      },
    );
  }

  return response;
}

// Clear the Supabase auth cookies + activity cookie and send the caller to the
// login screen (pages) or return 401 (APIs).
function buildIdleLogoutResponse(request: NextRequest) {
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  let res: NextResponse;
  if (isApi) {
    res = NextResponse.json(
      { success: false, error: "Session idle timeout." },
      { status: 401 },
    );
  } else {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("reason", "idle");
    res = NextResponse.redirect(loginUrl);
  }

  // Expire every Supabase auth cookie chunk + the activity cookie + the
  // "keep me signed in" preference (idle logout is a full logout).
  for (const cookie of request.cookies.getAll()) {
    if (
      cookie.name.startsWith("sb-") ||
      cookie.name === ADMIN_LAST_ACTIVE_COOKIE ||
      cookie.name === ADMIN_PERSIST_COOKIE
    ) {
      res.cookies.set(cookie.name, "", { path: "/", maxAge: 0 });
    }
  }
  return res;
}

export const config = {
  matcher: [
    // Skip static assets, the Next.js internals, and image files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
