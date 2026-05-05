"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type SidebarContextValue = {
  open: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

const STORAGE_KEY = "admin.sidebar.open";

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  // SSR 일치를 위해 항상 펼침 상태로 초기 렌더, 마운트 후 localStorage 동기화.
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "true" || saved === "false") {
        setOpen(saved === "true");
      }
    } catch {
      // localStorage 사용 불가 환경 무시
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      // 무시
    }
  }, [open]);

  const toggle = useCallback(() => setOpen((o) => !o), []);

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
