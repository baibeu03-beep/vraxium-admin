"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { HOME_LAUNCH_CARDS } from "@/lib/organizations";

// HOME 진입 카드. 조직명/색은 환경 배너와 동일한 통합 SoT(lib/organizations · HOME_LAUNCH_CARDS)를
//   재사용 — 여기서 조직명·색을 하드코딩하지 않는다. href 가 있으면 이동(활성), 없으면 미개설(진입 불가)
//   안내 토스트만 표시한다(기존 href·활성/비활성 판정 로직 그대로 — UI 표시만 변경).

const NOT_READY_MESSAGE = "아직 개설되지 않은 조직입니다.";

// 모든 카드 공통 뼈대 — 고정 높이(min-h)로 조직마다 높이·정렬이 달라지지 않게(레이아웃 일관).
//   색(배경/텍스트/테두리)은 카드별 variant 클래스가 얹는다(base 에 색 없음).
const CARD_BASE =
  "flex min-h-[128px] items-center justify-center rounded-xl border px-6 py-6 text-center shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

// 미개설(pending) 공용 스타일 — 활성 카드와 확실히 구분되는 흐린 배경 + 점선 테두리(진입 불가 신호).
const PENDING_CLASS =
  "border-dashed bg-muted/40 text-muted-foreground hover:bg-muted/60";

// 카드 내부 콘텐츠 — 아이콘 → 한글명(bold, 큼) → 영문명(작게, 대비). 모두 중앙 정렬.
//   비활성(미개설) 카드는 영문명·상태 문구 없이 한글명만 표시한다(en=null 로 호출).
function CardBody({
  icon,
  ko,
  en,
}: {
  icon: string | null;
  ko: string;
  en: string | null;
}) {
  return (
    <span className="flex flex-col items-center justify-center gap-0.5">
      {icon ? (
        <span className="text-2xl leading-none" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="text-xl font-bold tracking-tight">{ko}</span>
      {en ? (
        <span className="text-sm font-medium opacity-80">{en}</span>
      ) : null}
    </span>
  );
}

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
        {HOME_LAUNCH_CARDS.map((card) =>
          card.href ? (
            // 활성 조직/통합 — 링크 카드(조직 대표색 또는 중립색 + hover 강조).
            <Link
              key={card.key}
              href={card.href}
              className={cn(CARD_BASE, card.cardClass, card.cardHoverClass)}
            >
              <CardBody icon={card.icon} ko={card.ko} en={card.en} />
            </Link>
          ) : (
            // 미개설 — 진입 불가. 흐린 disabled 스타일로만 구분(한글명만 표시 — 영문명·상태 문구 없음).
            //   클릭 시 안내 토스트(기존 button 동작 유지 — 판정 로직/href 무변경).
            <button
              key={card.key}
              type="button"
              aria-disabled="true"
              onClick={() => showToast(NOT_READY_MESSAGE)}
              className={cn(CARD_BASE, PENDING_CLASS, "cursor-not-allowed")}
            >
              <CardBody icon={card.icon} ko={card.ko} en={null} />
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
