import { createBrowserClient } from "@supabase/ssr";
import {
  ADMIN_PERSIST_COOKIE,
  applyAdminSessionCookieOptions,
} from "@/lib/sessionCookieOptions";

let browserClient: ReturnType<typeof createBrowserClient> | undefined;

type BrowserCookieOptions = {
  path?: string;
  domain?: string;
  sameSite?: boolean | "lax" | "strict" | "none";
  secure?: boolean;
  maxAge?: number;
  expires?: Date;
  [key: string]: unknown;
};

// Minimal document.cookie read/write that mirrors @supabase/ssr's default
// browser handlers, kept consistent (encode on write / decode on read). We
// provide our own only so we can strip maxAge/expires on write — making the
// auth cookies session cookies. HttpOnly is intentionally never set: it cannot
// be applied via document.cookie and Supabase browser cookies are not HttpOnly.
function readAllCookies(): { name: string; value: string }[] {
  if (typeof document === "undefined" || !document.cookie) {
    return [];
  }
  return document.cookie.split(";").reduce<{ name: string; value: string }[]>(
    (acc, pair) => {
      const index = pair.indexOf("=");
      if (index === -1) {
        return acc;
      }
      const name = pair.slice(0, index).trim();
      if (!name) {
        return acc;
      }
      const rawValue = pair.slice(index + 1).trim();
      let value = rawValue;
      try {
        value = decodeURIComponent(rawValue);
      } catch {
        // Leave the raw value if it is not valid percent-encoding.
      }
      acc.push({ name, value });
      return acc;
    },
    [],
  );
}

function writeCookie(name: string, value: string, options?: BrowserCookieOptions) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  const path = options?.path ?? "/";
  cookie += `; Path=${path}`;
  if (options?.domain) {
    cookie += `; Domain=${options.domain}`;
  }
  if (options?.sameSite) {
    const raw =
      options.sameSite === true ? "strict" : String(options.sameSite);
    cookie += `; SameSite=${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
  }
  if (options?.secure) {
    cookie += "; Secure";
  }
  // For a normal "set", toSessionCookieOptions already removed maxAge/expires,
  // so nothing is appended here => session cookie (cleared on full browser
  // close). For a deletion (signOut / stale-chunk cleanup) it keeps maxAge:0
  // (or a past expiry), which we honor so the cookie is removed immediately.
  if (typeof options?.maxAge === "number") {
    cookie += `; Max-Age=${options.maxAge}`;
  }
  if (options?.expires instanceof Date) {
    cookie += `; Expires=${options.expires.toUTCString()}`;
  }
  document.cookie = cookie;
}

export function getSupabaseBrowserClient() {
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        // Custom document.cookie handlers so we can strip maxAge/expires on
        // writes (see lib/sessionCookieOptions.ts). The auth cookies become
        // session cookies: cleared when the browser fully closes, but they
        // survive tab close, reload (F5), navigation, and new tabs.
        cookies: {
          getAll() {
            return readAllCookies();
          },
          setAll(cookiesToSet) {
            if (typeof document === "undefined") {
              return;
            }
            // Read the "keep me signed in" opt-in at write-time so a preference
            // set right before signInWithPassword takes effect immediately.
            const persist = readAllCookies().some(
              (c) => c.name === ADMIN_PERSIST_COOKIE && c.value === "1",
            );
            for (const { name, value, options } of cookiesToSet) {
              writeCookie(
                name,
                value,
                applyAdminSessionCookieOptions(
                  options as BrowserCookieOptions,
                  persist,
                ),
              );
            }
          },
        },
      },
    );
  }
  return browserClient;
}
