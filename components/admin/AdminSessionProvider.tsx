"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { ADMIN_IDLE_TIMEOUT_MS } from "@/lib/adminSessionConfig";
import { postAdminLogout, subscribeAdminLogout } from "@/lib/adminAuthChannel";

// Single source of truth for the admin idle session on the client. It owns ONE
// activity timestamp and ONE 1-second tick that drives BOTH:
//   · the auto-logout decision (remaining <= 0 → sign out + redirect), and
//   · the header countdown display (SessionCountdown reads `remainingMs` here).
// There is no separate display timer — the number shown is exactly the value the
// logout decision uses, so they can never drift.
//
// Also keeps the server's sliding cookie fresh via a heartbeat while the user is
// active, and leaves immediately on a cross-tab logout broadcast. The server
// (middleware) remains the authoritative HTTP gate; this is the client half.

const TICK_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

type AdminSessionValue = {
  remainingMs: number;
  idleTimeoutMs: number;
};

const AdminSessionContext = createContext<AdminSessionValue | null>(null);

export function useAdminSession(): AdminSessionValue {
  const ctx = useContext(AdminSessionContext);
  return ctx ?? { remainingMs: ADMIN_IDLE_TIMEOUT_MS, idleTimeoutMs: ADMIN_IDLE_TIMEOUT_MS };
}

export default function AdminSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const lastActivityRef = useRef<number>(0);
  const loggingOutRef = useRef(false);
  const [remainingMs, setRemainingMs] = useState<number>(ADMIN_IDLE_TIMEOUT_MS);

  // Navigation resets the countdown too: user-initiated navigation always fires
  // a click/key activity event (handled below), and a full page load remounts
  // this provider fresh — so no separate route effect is needed.
  useEffect(() => {
    lastActivityRef.current = Date.now();

    const leaveToLogin = (reason: "idle" | "remote") => {
      if (loggingOutRef.current) return;
      loggingOutRef.current = true;
      void (async () => {
        try {
          const { getSupabaseBrowserClient } = await import("@/lib/supabaseBrowser");
          await getSupabaseBrowserClient().auth.signOut({ scope: "local" });
        } catch {
          // ignore — redirect below still leaves the admin area
        }
        if (reason === "idle") {
          postAdminLogout();
          router.replace("/login?reason=idle");
        } else {
          router.replace("/login");
        }
        router.refresh();
      })();
    };

    // Any user interaction resets the activity clock (and thus the countdown).
    const markActivity = () => {
      lastActivityRef.current = Date.now();
      setRemainingMs(ADMIN_IDLE_TIMEOUT_MS);
    };

    // Throttle high-frequency events; the first event in a window resets
    // immediately so discrete clicks/keys feel instant.
    let throttled = false;
    const onActivity = () => {
      if (throttled) return;
      throttled = true;
      markActivity();
      window.setTimeout(() => {
        throttled = false;
      }, 500);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") markActivity();
    };

    const activityEvents: (keyof WindowEventMap)[] = [
      "pointerdown",
      "keydown",
      "mousemove",
      "scroll",
      "touchstart",
      "wheel",
    ];
    for (const evt of activityEvents) {
      window.addEventListener(evt, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisible);

    // The single tick: display + logout, same SoT.
    const tick = window.setInterval(() => {
      const remaining = ADMIN_IDLE_TIMEOUT_MS - (Date.now() - lastActivityRef.current);
      if (remaining <= 0) {
        setRemainingMs(0);
        leaveToLogin("idle");
      } else {
        setRemainingMs(remaining);
      }
    }, TICK_MS);

    // Heartbeat while active — refreshes the server's sliding cookie so a user
    // active on a single page (no navigation) is not logged out by the server.
    const heartbeat = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current < HEARTBEAT_INTERVAL_MS) {
        void fetch("/api/admin/session/heartbeat", {
          method: "GET",
          cache: "no-store",
          credentials: "include",
        }).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Cross-tab logout.
    const unsubscribe = subscribeAdminLogout(() => leaveToLogin("remote"));

    return () => {
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onActivity);
      }
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(tick);
      window.clearInterval(heartbeat);
      unsubscribe();
    };
  }, [router]);

  return (
    <AdminSessionContext.Provider value={{ remainingMs, idleTimeoutMs: ADMIN_IDLE_TIMEOUT_MS }}>
      {children}
    </AdminSessionContext.Provider>
  );
}
