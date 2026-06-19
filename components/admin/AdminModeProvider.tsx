"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ADMIN_MODE_STORAGE_KEY,
  parseScopeMode,
  setModeQuery,
  type ScopeMode,
} from "@/lib/userScopeShared";

type AdminModeContextValue = {
  mode: ScopeMode;
  setMode(mode: ScopeMode): void;
  href(href: string): string;
};

const AdminModeContext = createContext<AdminModeContextValue | null>(null);

function readStoredMode(): ScopeMode {
  try {
    return parseScopeMode(localStorage.getItem(ADMIN_MODE_STORAGE_KEY));
  } catch {
    return "operating";
  }
}

export function AdminModeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const explicitMode = searchParams.get("mode");
  const hasExplicitMode = explicitMode !== null;
  const mode = parseScopeMode(explicitMode);
  const modeRef = useRef(mode);
  const [ready, setReady] = useState(hasExplicitMode);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (!pathname.startsWith("/admin")) return;
    if (hasExplicitMode) {
      try {
        localStorage.setItem(ADMIN_MODE_STORAGE_KEY, mode);
      } catch {
        // Storage may be unavailable.
      }
      // URL/localStorage 해석 완료 후에만 하위 화면의 admin fetch를 시작한다.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReady(true);
      return;
    }
    const stored = readStoredMode();
    if (stored === "test") {
      setReady(false);
      router.replace(setModeQuery(`${pathname}?${searchParams}`, stored));
      return;
    }
    setReady(true);
  }, [hasExplicitMode, mode, pathname, router, searchParams]);

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (!raw.startsWith("/api/admin/")) return originalFetch(input, init);
      const effectiveMode = hasExplicitMode
        ? modeRef.current
        : readStoredMode();
      const scoped = setModeQuery(raw, effectiveMode);
      return input instanceof Request
        ? originalFetch(
            new Request(new URL(scoped, window.location.origin), input),
            init,
          )
        : originalFetch(scoped, init);
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, [hasExplicitMode]);

  const value = useMemo<AdminModeContextValue>(
    () => ({
      mode,
      setMode(nextMode) {
        try {
          localStorage.setItem(ADMIN_MODE_STORAGE_KEY, nextMode);
        } catch {
          // Storage may be unavailable.
        }
        router.push(
          setModeQuery(`${pathname}?${searchParams.toString()}`, nextMode),
        );
      },
      href: (target) => setModeQuery(target, mode),
    }),
    [mode, pathname, router, searchParams],
  );

  if (!ready) return null;

  return (
    <AdminModeContext.Provider value={value}>
      {children}
    </AdminModeContext.Provider>
  );
}

export function useAdminMode() {
  const value = useContext(AdminModeContext);
  if (!value) throw new Error("useAdminMode must be used inside AdminModeProvider");
  return value;
}
