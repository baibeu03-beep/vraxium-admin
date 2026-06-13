"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

// 운영/테스트 모드 토글(표시 전용 UI).
// ─────────────────────────────────────────────────────────────────────
// userScope(서버) 의 ?mode=test 를 켜고 끄는 클라이언트 토글. 백엔드/스코프/snapshot
// 무관 — URL query 만 조작한다(org/tab/week 등 기존 query 보존).
//
// 노출 규칙:
//   · admin 경로(/admin/*) 에서만 표시(고객 앱 미표시).
//   · 최초에는 숨김. ?mode=test 에 한 번이라도 진입하면 localStorage(seen) 에 기록하고,
//     이후 admin 페이지에서는 계속 표시(operating 으로 돌아와도 ON 으로 복구 가능).
// ─────────────────────────────────────────────────────────────────────

const SEEN_KEY = "vraxium.admin.testModeSeen";

function TestModeToggleInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  // localStorage 는 클라이언트 전용 → 마운트 후 읽는다(hydration 안전, 최초 false).
  const [seen, setSeen] = useState(false);

  const isAdmin = pathname?.startsWith("/admin") ?? false;
  const isTest = searchParams.get("mode") === "test";

  useEffect(() => {
    if (isTest) {
      // 테스트 모드 진입 → seen 기록(이후 계속 노출).
      try {
        localStorage.setItem(SEEN_KEY, "1");
      } catch {
        /* localStorage 불가(프라이빗 모드 등) — 무시 */
      }
      setSeen(true);
    } else {
      try {
        setSeen(localStorage.getItem(SEEN_KEY) === "1");
      } catch {
        setSeen(false);
      }
    }
  }, [isTest]);

  // admin 경로가 아니면(고객 앱 포함) 절대 표시하지 않는다.
  if (!isAdmin) return null;
  // 최초(테스트 모드 미진입) 에는 숨김.
  if (!isTest && !seen) return null;

  const toggle = () => {
    // 기존 query(org/tab/week 등) 전부 보존하고 mode 만 추가/삭제.
    const params = new URLSearchParams(searchParams.toString());
    if (isTest) params.delete("mode");
    else params.set("mode", "test");
    const qs = params.toString();
    router.push(`${pathname}${qs ? `?${qs}` : ""}`);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={isTest}
      title={
        isTest
          ? "테스트 모드 켜짐 — 클릭하면 운영 모드로 전환"
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

// useSearchParams 는 Suspense 경계가 필요하다 — fallback={null} 로 감싼다.
export default function TestModeToggle() {
  return (
    <Suspense fallback={null}>
      <TestModeToggleInner />
    </Suspense>
  );
}
