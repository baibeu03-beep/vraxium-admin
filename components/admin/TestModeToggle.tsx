"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminMode } from "@/components/admin/AdminModeProvider";

function TestModeToggleInner() {
  const pathname = usePathname();
  const { mode, setMode } = useAdminMode();
  const isAdmin = pathname?.startsWith("/admin") ?? false;
  const isTest = mode === "test";

  if (!isAdmin) return null;

  return (
    <button
      type="button"
      onClick={() => setMode(isTest ? "operating" : "test")}
      aria-pressed={isTest}
      title={
        isTest
          ? "테스트 모드 ON — 클릭하면 운영 모드로 전환"
          : "운영 모드 — 클릭하면 테스트 모드로 전환"
      }
      className={cn(
        "fixed bottom-4 right-4 z-50 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold shadow-lg transition-colors",
        isTest
          ? "border-amber-400 bg-amber-500 text-white hover:bg-amber-600"
          : "border-input bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      <FlaskConical className="h-4 w-4" />
      {isTest ? "테스트 모드 ON" : "테스트 모드 OFF"}
    </button>
  );
}

export default function TestModeToggle() {
  return (
    <Suspense fallback={null}>
      <TestModeToggleInner />
    </Suspense>
  );
}
