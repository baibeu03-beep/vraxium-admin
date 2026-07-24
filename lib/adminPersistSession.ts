// Client-side helpers for the "로그인 상태 유지" (keep me signed in) opt-in.
//
// The preference lives in a small, non-sensitive cookie (ADMIN_PERSIST_COOKIE)
// so BOTH the browser Supabase client and the server middleware read the same
// signal and apply the same cookie lifetime (see lib/sessionCookieOptions.ts).
// It holds only "1" — never a password, token, or any session material.
//
// It must be set BEFORE signInWithPassword so the auth-cookie writes triggered by
// the sign-in already pick up the persistent lifetime, and cleared on sign-out so
// the session is fully discarded (the sb-* cookies are wiped by signOut itself).

import {
  ADMIN_PERSIST_COOKIE,
  ADMIN_PERSIST_MAX_AGE_S,
} from "@/lib/sessionCookieOptions";

function secureAttr(): string {
  return typeof window !== "undefined" && window.location.protocol === "https:"
    ? "; Secure"
    : "";
}

// Opt in / out of persistence. When keeping, the preference cookie itself is
// persistent for the same 7-day window so it survives browser close; otherwise
// it is deleted immediately.
export function setKeepSignedIn(keep: boolean): void {
  if (typeof document === "undefined") return;
  if (keep) {
    document.cookie =
      `${ADMIN_PERSIST_COOKIE}=1; Path=/; Max-Age=${ADMIN_PERSIST_MAX_AGE_S}` +
      `; SameSite=Lax${secureAttr()}`;
  } else {
    document.cookie =
      `${ADMIN_PERSIST_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secureAttr()}`;
  }
}

// Clear the preference (used on logout so persistence never lingers past a
// deliberate sign-out).
export function clearKeepSignedIn(): void {
  setKeepSignedIn(false);
}

// Read the current preference from document.cookie.
export function readKeepSignedIn(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((pair) => pair.trim() === `${ADMIN_PERSIST_COOKIE}=1`);
}
