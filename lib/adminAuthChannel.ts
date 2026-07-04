// Cross-tab admin auth signaling (client-only).
//
// When one tab logs out (manual button or idle timeout), the shared Supabase
// cookies are cleared for the whole browser profile, so every tab is already
// unauthenticated at the cookie level. This channel just tells the *other* open
// tabs to immediately leave the admin UI and show the login screen, instead of
// waiting for their next navigation. Uses BroadcastChannel (same-origin, all
// tabs/windows of the profile); a no-op where BroadcastChannel is unavailable.

const CHANNEL_NAME = "admin-auth";

type AdminAuthMessage = { type: "logout" };

export function postAdminLogout(): void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return;
  }
  try {
    const bc = new BroadcastChannel(CHANNEL_NAME);
    bc.postMessage({ type: "logout" } satisfies AdminAuthMessage);
    bc.close();
  } catch {
    // ignore — best effort
  }
}

// Subscribe to logout broadcasts from other tabs. Returns an unsubscribe fn.
export function subscribeAdminLogout(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(CHANNEL_NAME);
    bc.onmessage = (event: MessageEvent<AdminAuthMessage>) => {
      if (event.data?.type === "logout") callback();
    };
  } catch {
    return () => {};
  }
  return () => {
    try {
      bc?.close();
    } catch {
      // ignore
    }
  };
}
