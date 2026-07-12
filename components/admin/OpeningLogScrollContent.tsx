"use client";

import * as React from "react";
import { CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { OPENING_LOG_SCROLL_THRESHOLD } from "@/lib/openingLogView";

// /admin/line-opening/* 세 로그창(실무 정보/역량/경험) 공용 스크롤 뷰포트.
//   요구 동작:
//    · 로그 7개 이하 → 내부 스크롤 없음, 전체가 자연스럽게 표시(고정 높이/빈 공간 없음).
//    · 로그 8개 이상 → Card 전체가 아니라 이 CardContent 안에서만 세로 스크롤. 최대 7행까지만 보인다.
//    · 가로 스크롤 없음(overflow-x-hidden + 행 자연 줄바꿈).
//    · 8개 이상 최초 진입 → 맨 아래(최신 로그)를 보여준다.
//   높이 계산(줄바꿈 안전):
//    · "7 * 고정 px" 금지(행이 줄바꿈되면 8번째가 어중간하게 노출). 대신 7번째 로그 행의 실제
//      렌더 bottom 을 측정해 max-height 로 지정 → 항상 정확히 7개까지만 보인다.
//   자동 하단 스크롤 조건:
//    · changeKey(개수+최신 id+생성시각 조합)가 "실제로" 바뀔 때만 하단으로 이동한다.
//    · 리렌더/배열 재생성만으로는 스크롤하지 않는다(사용자가 위로 스크롤한 위치를 뺏지 않음).
//    · 창 리사이즈 시엔 높이만 재측정하고, 이미 하단을 보던 경우에만 하단 유지(임의 튕김 금지).
//   contract: children 은 각 로그 행(<p> 등) "직접 자식"의 평면 목록이어야 한다(7번째 = children[6]).
//    로딩/빈 상태는 count<8 이라 측정/스크롤 대상이 아니다(그대로 렌더).

export default function OpeningLogScrollContent({
  count,
  changeKey,
  className,
  children,
}: {
  /** 현재 로그 개수. 8 이상이면 내부 스크롤 + 7행 높이 제한이 적용된다. */
  count: number;
  /** 자동 하단 스크롤을 트리거하는 안정적 키(lib/openingLogView.logChangeKey). */
  changeKey: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const countRef = React.useRef(count);
  // 매 렌더 후 최신 count 반영 — ResizeObserver 콜백이 최신 값을 읽도록.
  React.useEffect(() => {
    countRef.current = count;
  });

  // max-height(7행) 측정 + 적용. keepBottom=true 면 하단으로 스크롤(최신 로그로 이동).
  //   측정은 항상 "제약 해제(자연 높이) 상태"에서 수행 → 현재 스크롤 위치에 흔들리지 않는다.
  const applyConstraint = React.useCallback((keepBottom: boolean) => {
    const el = ref.current;
    if (!el) return;

    // 8개 미만 → 제약 없음(자연 표시).
    if (countRef.current < OPENING_LOG_SCROLL_THRESHOLD) {
      el.style.maxHeight = "";
      el.style.overflowY = "";
      return;
    }

    // 재측정 전 스크롤 의도 보존(리사이즈 시 튕김 방지).
    const wasConstrained = el.style.maxHeight !== "";
    const wasAtBottom =
      wasConstrained &&
      Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < 2;
    const prevScrollTop = el.scrollTop;

    // 자연 높이로 되돌려 측정(스크롤 컨테이너 해제 → children rect 가 실제 위치).
    el.style.maxHeight = "";
    el.style.overflowY = "";

    const rows = el.children;
    if (rows.length < OPENING_LOG_SCROLL_THRESHOLD) return; // 안전장치

    const seventh = rows[OPENING_LOG_SCROLL_THRESHOLD - 2] as HTMLElement; // 7번째(0-index 6)
    const containerTop = el.getBoundingClientRect().top;
    // 컨테이너 상단~7번째 행 하단 = 정확히 7행이 보이는 높이. box-sizing:border-box 라 세로 패딩 포함.
    const h = Math.ceil(seventh.getBoundingClientRect().bottom - containerTop);

    el.style.maxHeight = `${h}px`;
    el.style.overflowY = "auto";

    if (keepBottom || wasAtBottom) el.scrollTop = el.scrollHeight;
    else el.scrollTop = prevScrollTop;
  }, []);

  // 로그 변경(개수/최신 항목) 시: 높이 재측정 + 최신 로그로 이동. 리렌더만으론 실행되지 않음.
  React.useLayoutEffect(() => {
    countRef.current = count;
    applyConstraint(true);
  }, [changeKey, count, applyConstraint]);

  // 리사이즈(행 줄바꿈 변화) → 높이만 재측정, 스크롤 위치는 보존.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => applyConstraint(false));
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyConstraint]);

  return (
    <CardContent
      ref={ref}
      className={cn(
        // 세로 높이는 위 이펙트가 max-height 로 제어(8+). 가로 스크롤은 항상 차단.
        "flex-1 min-h-0 space-y-1.5 overflow-x-hidden text-sm",
        className,
      )}
    >
      {children}
    </CardContent>
  );
}
