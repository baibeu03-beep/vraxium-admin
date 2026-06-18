"use client";

import {
  createContext,
  useCallback,
  useContext,
  useState,
  useSyncExternalStore,
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

// 초기 테마는 DOM 의 html.dark class 에서 읽는다 — blocking 스크립트(themeInitScript)가
// 하이드레이션 전에 localStorage 를 반영해 class 를 이미 맞춰뒀으므로 이것이 진실값이다.
// (SSR 에서는 document 가 없어 "light" — 안전 기본값.)
function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

// effect 없이 클라이언트 마운트 여부만 판별(SSR=false · client=true).
// react-hooks/set-state-in-effect 규칙을 피하면서 토글 아이콘 hydration mismatch 를 막는다.
const subscribeNoop = () => () => {};

type ThemeContextValue = {
  theme: Theme;
  /** 하이드레이션 완료 여부 — 토글 아이콘 mismatch 방지용. */
  mounted: boolean;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // 초기값은 DOM class 에서 lazily 읽는다(client=실제 테마 · server=light). effect 불필요.
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);
  const mounted = useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );

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
    // 현재값은 DOM(진실값)에서 읽어 setTheme 에 위임 — updater 내부 side effect 없이 순수.
    const isDark = document.documentElement.classList.contains("dark");
    setTheme(isDark ? "light" : "dark");
  }, [setTheme]);

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
