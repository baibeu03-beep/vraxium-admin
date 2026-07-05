// Best-effort, verification-FREE decode of a JWT payload.
//
// Callers MUST have already verified the token's authenticity (e.g. via
// `supabase.auth.getUser()`, which validates with the auth server). This helper
// only reads non-sensitive bookkeeping claims (`session_id`, `iat`) from an
// already-trusted token — it performs no signature check itself.
//
// Uses only Web-standard globals (`atob`, `TextDecoder`) so it runs on both the
// Edge and Node.js runtimes that middleware may execute on.

export function decodeJwtClaims(
  token: string | null | undefined,
): Record<string, unknown> | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
