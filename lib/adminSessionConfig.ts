// Shared configuration for the standard cookie-based admin session policy.
// Imported by BOTH the server (middleware) and the client (AdminSessionManager),
// so it must stay free of server-only imports. The idle window is read from a
// NEXT_PUBLIC_ env var (inlined at build time, available on both sides) so the
// server enforcement and the client watcher always use the same threshold.

// Name of the sliding "last activity" cookie. Written by middleware on every
// authenticated request; it is a *session* cookie (no Max-Age) so it also dies
// on full browser close. Idle timeout is enforced by comparing its timestamp,
// not by cookie expiry.
export const ADMIN_LAST_ACTIVE_COOKIE = "admin_last_active";

// Idle timeout: auto-logout after this much inactivity. Default 20 minutes
// (within the requested 15–30 min range). Override with
// NEXT_PUBLIC_ADMIN_IDLE_TIMEOUT_MS (e.g. a small value in tests).
const DEFAULT_IDLE_TIMEOUT_MS = 20 * 60 * 1000;

function parseIdleMs(): number {
  const raw = process.env.NEXT_PUBLIC_ADMIN_IDLE_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 10_000) {
      return parsed;
    }
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

export const ADMIN_IDLE_TIMEOUT_MS = parseIdleMs();
