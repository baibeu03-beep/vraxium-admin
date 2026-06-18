"use client";

import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

// ─────────────────────────────────────────────────────────────────────────────
// ThemeProvider — 프로젝트 전역 라이트/다크 테마 SoT.
//
// globals.css 에는 이미 :root(라이트) / .dark(다크) 토큰이 모두 정의되어 있다.
// 여기서는 html(document.documentElement)의 `dark` class 만 토글하면 모든
// semantic token(배경/전경/border/badge/tone …)이 자동으로 갈아끼워진다.
//
// 테마의 진실값(SoT) = html.dark class 자체. useSyncExternalStore 로 그 class 를
// 구독한다 → effect 없이(react-hooks/set-state-in-effect 회피) 하이드레이션 안전.
// getServerSnapshot 은 SSR + **클라이언트 하이드레이션** 모두에서 쓰이므로 항상
// "light" 를 반환해 서버 HTML 과 일치 → mismatch 경고 없음. 하이드레이션 직후
// getSnapshot(실제 DOM)으로 전환되며 자동 재렌더된다.
//
// · 저장: localStorage(THEME_STORAGE_KEY) — 새로고침 후에도 선택 유지.
// · 초기 적용: app/layout.tsx 의 beforeInteractive 스크립트(themeInitScript)가
//   하이드레이션 전에 class 를 먼저 세팅 → 다크 새로고침 시 흰 화면 깜빡임(FOUC) 제거.
// · 기본값: light(가장 안전 — 기존 디자인 무회귀). 저장값 있으면 그것을 따른다.
//
// next-themes 의존성 대신 기존 sidebarContext 와 동일한 useSyncExternalStore 패턴.
// ─────────────────────────────────────────────────────────────────────────────

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "vraxium-theme";

// 같은 탭 내 즉시 동기화용 커스텀 이벤트(다른 탭은 storage 이벤트로 동기화).
const THEME_CHANGE_EVENT = "vraxium-theme-change";

// app/layout.tsx 에 beforeInteractive 로 주입되는 스크립트(하이드레이션 전 class 적용).
export const themeInitScript = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'){document.documentElement.classList.add('dark');}else{document.documentElement.classList.remove('dark');}}catch(e){}})();`;

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* localStorage 차단 — DOM class 로만 동작(새로고침 시 유지 안 됨). */
  }
  // 같은 탭의 useSyncExternalStore 구독자 즉시 갱신.
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((next: Theme) => applyTheme(next), []);
  const toggleTheme = useCallback(
    () => applyTheme(getSnapshot() === "dark" ? "light" : "dark"),
    [],
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
