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

type CookieSetOptions =
  | {
      maxAge?: number;
      expires?: Date | number | string;
      [key: string]: unknown;
    }
  | undefined;

// Strip lifetime hints so a "set" becomes a session cookie. Deletions
// (maxAge <= 0) are left untouched so signOut and stale-chunk cleanup still
// expire cookies immediately.
export function toSessionCookieOptions<T extends CookieSetOptions>(options: T): T {
  if (!options) {
    return options;
  }

  const maxAge = options.maxAge;
  const isDeletion = typeof maxAge === "number" && maxAge <= 0;
  if (isDeletion) {
    return options;
  }

  const next = { ...options };
  delete next.maxAge;
  delete next.expires;
  return next as T;
}
