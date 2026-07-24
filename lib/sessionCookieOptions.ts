// Turns Supabase auth cookies into browser "session cookies" so that the login
// session ends when the browser is fully closed — but survives tab close, page
// reloads (F5), navigations, and opening new tabs.
//
// Why this is needed: @supabase/ssr forcibly stamps every auth cookie it *sets*
// with `maxAge: 400 days` (see node_modules/@supabase/ssr — DEFAULT_COOKIE_OPTIONS),
// which makes them persistent cookies that outlive a browser restart. Passing a
// custom `cookieOptions.maxAge` does NOT help because the library overrides it.
// The only reliable hook is to strip `maxAge`/`expires` in the actual cookie
// writer (`setAll`), which is what every Supabase client in this app routes
// through. A cookie with no `maxAge`/`expires` is, by HTTP spec, a session
// cookie: the browser drops it when the last window of the browser closes.
//
// This is the standard session-management approach (session cookies). We do NOT
// detect browser close via `beforeunload` (unreliable across browsers).
//
// "로그인 상태 유지" (keep me signed in) opt-in: when the admin ticks that box on
// the login screen we write a small, non-sensitive preference cookie
// (ADMIN_PERSIST_COOKIE) and every auth-cookie writer below caps Supabase's
// 400-day maxAge to a 7-day *persistent* cookie instead of stripping it. The
// session then survives full browser close for up to 7 days — but the 20-minute
// idle auto-logout (middleware + AdminSessionProvider) still applies unchanged,
// and signOut still wipes everything immediately. No password/JWT is ever stored
// client-side; only the session cookies' lifetime changes.

// Name of the opt-in preference cookie. Non-sensitive (holds "1" only), readable
// by both the browser client and server middleware so the same lifetime policy
// is applied on every cookie write. Set/cleared via lib/adminPersistSession.ts.
export const ADMIN_PERSIST_COOKIE = "admin_keep_signed_in";

// Remember-me window: how long a persisted admin session survives browser close.
export const ADMIN_PERSIST_MAX_AGE_S = 7 * 24 * 60 * 60; // 7 days

type CookieSetOptions =
  | {
      maxAge?: number;
      expires?: Date | number | string;
      [key: string]: unknown;
    }
  | undefined;

// Apply the admin session lifetime policy to a single cookie "set":
//   · persist=false → strip maxAge/expires ⇒ session cookie (dies on browser
//     close). The default policy.
//   · persist=true  → cap the lifetime to the 7-day remember-me window ⇒ a
//     persistent cookie that survives browser close.
// Deletions (maxAge <= 0) are always left untouched so signOut and stale-chunk
// cleanup still expire cookies immediately.
export function applyAdminSessionCookieOptions<T extends CookieSetOptions>(
  options: T,
  persist: boolean,
): T {
  if (!options) {
    return options;
  }

  const maxAge = options.maxAge;
  const isDeletion = typeof maxAge === "number" && maxAge <= 0;
  if (isDeletion) {
    return options;
  }

  const next = { ...options };
  if (persist) {
    // Cap Supabase's forced 400-day maxAge to our 7-day remember-me window.
    next.maxAge = ADMIN_PERSIST_MAX_AGE_S;
    delete next.expires;
  } else {
    delete next.maxAge;
    delete next.expires;
  }
  return next as T;
}

// Back-compat convenience: the default (non-persistent) session-cookie policy.
export function toSessionCookieOptions<T extends CookieSetOptions>(options: T): T {
  return applyAdminSessionCookieOptions(options, false);
}
