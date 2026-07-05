// Codec for the sliding `admin_last_active` cookie value.
//
// Format: "<timestampMs>"            (legacy, timestamp only)
//     or  "<timestampMs>.<sessionId>"
//
// The session id ties the activity marker to a *specific* login. Without it, a
// stale marker left over from a previous session (it is HttpOnly, so a
// client-side signOut cannot clear it) would idle-expire a session that was just
// re-established on the very next login — surfacing as an intermittent
// "로그인 세션을 서버에서 확인하지 못했습니다." right after auto-logout.
//
// Supabase access-token `session_id` is stable across token refreshes within one
// login and only changes on a fresh sign-in, so comparing it lets middleware
// distinguish "the same session, genuinely idle" (enforce logout) from "a new
// login with a leftover marker" (slide the window instead). Session ids are
// UUIDs and never contain a ".", so the first dot cleanly separates the fields.

export type ActivityMarker = { timestampMs: number; sessionId: string | null };

export function encodeActivityMarker(
  timestampMs: number,
  sessionId: string | null,
): string {
  return sessionId ? `${timestampMs}.${sessionId}` : String(timestampMs);
}

export function decodeActivityMarker(
  raw: string | undefined | null,
): ActivityMarker | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  const tsPart = dot === -1 ? raw : raw.slice(0, dot);
  const timestampMs = Number(tsPart);
  if (!Number.isFinite(timestampMs)) return null;
  const sessionId = dot === -1 ? null : raw.slice(dot + 1) || null;
  return { timestampMs, sessionId };
}

// Decide whether `stored` (a previously written marker) belongs to the CURRENT
// login, given the current access token's session id and issued-at (ms).
//   · Both session ids known  → compare them directly.
//   · Otherwise (legacy marker or missing claim) → fall back to iat: a token
//     issued AFTER the marker means a newer login wrote it, so it is NOT the
//     same session. If neither signal is available, default to `true` so idle
//     enforcement is never silently weakened.
export function isSameLogin(
  stored: ActivityMarker,
  currentSessionId: string | null,
  currentIssuedAtMs: number | null,
): boolean {
  if (stored.sessionId && currentSessionId) {
    return stored.sessionId === currentSessionId;
  }
  if (currentIssuedAtMs !== null) {
    return currentIssuedAtMs <= stored.timestampMs;
  }
  return true;
}
