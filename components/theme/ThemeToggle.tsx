"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme/ThemeProvider";

// 라이트/다크 전환 버튼. 헤더 우측에 배치.
// 토큰 기반이라 별도 색 지정 없이 variant=ghost 로 헤더와 자연스럽게 어울린다.
export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, mounted, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      className={className}
    >
      {/* mounted 전에는 아이콘 확정 불가(SSR=light 가정) → 하이드레이션 mismatch 방지 위해
          마운트 전까지는 한쪽 아이콘만 그려 깜빡임/경고를 피한다. */}
      {!mounted ? (
        <Sun className="h-4 w-4" />
      ) : isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}
