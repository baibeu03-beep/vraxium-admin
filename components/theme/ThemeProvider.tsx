"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
// ThemeProvider — 프로젝트 전역 라이트/다크 테마 SoT.
//
// globals.css 에는 이미 :root(라이트) / .dark(다크) 토큰이 모두 정의되어 있다.
// 여기서는 html(document.documentElement)의 `dark` class 만 토글하면 모든
// semantic token(배경/전경/border/badge/tone …)이 자동으로 갈아끼워진다.
//
// · 저장: localStorage(THEME_STORAGE_KEY) — 새로고침 후에도 선택 유지.
// · 초기값: 라이트(가장 안전 — 기존 디자인 무회귀). 저장값이 있으면 그것을 따른다.
// · FOUC 방지: app/layout.tsx 의 blocking <script>(themeInitScript)가 페인트
//   전에 class 를 먼저 적용한다. 이 Provider 는 런타임 토글·동기화만 담당.
//
// next-themes 를 새 의존성으로 추가하는 대신, 기존 sidebarContext 와 동일한
// 경량 Context 패턴으로 맞춰 구현했다(번들/SSR 일관성).
// ─────────────────────────────────────────────────────────────────────────────

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "vraxium-theme";

// app/layout.tsx <head> 에 인라인으로 주입되는 blocking 스크립트.
// 하이드레이션 전에 저장된 테마를 읽어 html.dark 를 즉시 적용 → 다크 새로고침 시 흰 화면 깜빡임 제거.
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`;

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

type ThemeContextValue = {
  theme: Theme;
  /** 하이드레이션 완료 여부 — 토글 아이콘 mismatch 방지용. */
  mounted: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR/초기 렌더는 항상 라이트로 가정(blocking 스크립트가 실제 DOM class 는 이미 맞춰둠).
  const [theme, setThemeState] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  // 마운트 시 저장값과 동기화(blocking 스크립트가 적용한 값을 React state 로 끌어온다).
  useEffect(() => {
    const stored = readStoredTheme();
    setThemeState(stored);
    applyTheme(stored);
    setMounted(true);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* localStorage 차단 환경 — 메모리 상태로만 동작. */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, mounted, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
