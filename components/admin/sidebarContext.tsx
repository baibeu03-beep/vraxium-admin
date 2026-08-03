"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

type SidebarContextValue = {
  open: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

// 탭별 독립 상태: sessionStorage 는 브라우저 탭마다 별도 영역을 가지므로
// 다른 탭·다른 브라우저와 절대 공유되지 않는다(새로고침 시에는 같은 탭이라 유지됨).
const STORAGE_KEY = "admin.sidebar.open";
// 같은 탭 안에서 setOpen 직후 즉시 리렌더시키기 위한 커스텀 이벤트.
// 브라우저 네이티브 storage 이벤트는 다른 탭에만 발화되므로 여기서는 쓰지 않는다.
const CHANGE_EVENT = "admin-sidebar-open-change";

function getSnapshot() {
  if (typeof window === "undefined") return true;
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    if (saved === "false") return false;
  } catch {
    // sessionStorage unavailable
  }
  return true;
}

function subscribe(onStoreChange: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener(CHANGE_EVENT, onStoreChange);
  return () => window.removeEventListener(CHANGE_EVENT, onStoreChange);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const open = useSyncExternalStore(subscribe, getSnapshot, () => true);

  const setOpen = useCallback((value: boolean) => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, String(value));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    } catch {
      // ignore
    }
  }, []);

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  return (
    <SidebarContext.Provider value={{ open, toggle, setOpen }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used inside <SidebarProvider>");
  }
  return ctx;
}
