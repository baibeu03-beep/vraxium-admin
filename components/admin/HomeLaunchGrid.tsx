"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

// HOME 진입 버튼. href 가 있으면 이동, 없으면 미구축 안내 토스트만 표시.
type LaunchItem = { label: string; href?: string };

const ITEMS: LaunchItem[] = [
  { label: "통합 검수 시스템", href: "/admin/members" },
  { label: "엥크레", href: "/admin/crews/encre" },
  { label: "오랑캐", href: "/admin/crews/oranke" },
  { label: "팔랑크스", href: "/admin/crews/phalanx" },
  { label: "스쿼드" },
  { label: "디오니소스" },
  { label: "A-Q" },
  { label: "코쿤탁" },
];

const NOT_READY_MESSAGE = "프로세스가 DB화 되지 않았습니다.";

const cardClass =
  "flex min-h-[88px] items-center justify-center rounded-xl border border-border bg-background px-6 py-7 text-center text-lg font-bold tracking-tight text-foreground shadow-sm transition-colors hover:bg-muted/70 hover:border-foreground/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function HomeLaunchGrid() {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const showToast = (message: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast(message);
    timerRef.current = setTimeout(() => setToast(null), 2500);
  };

  return (
    <section aria-label="시스템 진입" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ITEMS.map((item) =>
          item.href ? (
            <Link key={item.label} href={item.href} className={cardClass}>
              {item.label}
            </Link>
          ) : (
            <button
              key={item.label}
              type="button"
              onClick={() => showToast(NOT_READY_MESSAGE)}
              className={cn(cardClass, "cursor-pointer")}
            >
              {item.label}
            </button>
          ),
        )}
      </div>

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-border bg-foreground px-5 py-3 text-sm font-semibold text-background shadow-lg"
        >
          {toast}
        </div>
      )}
    </section>
  );
}
