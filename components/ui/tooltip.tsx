"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// 공용 hover/focus 툴팁 — 전역 단일 SoT(디자인 출처는 이 파일 하나).
//   · 화면 툴팁 내용을 React state(content)로 렌더 → 열려 있는 동안 content 가 바뀌면 "즉시" 갱신된다
//     (네이티브 title 은 표시 중 속성 변경을 반영하지 못하는 한계가 있어, lazy 조회 결과가 안 보였음).
//   · body 로 portal(fixed) → 표(overflow) 안에서도 잘리지 않는다.
//   · onOpen 콜백으로 "열릴 때" lazy 조회를 트리거할 수 있다.
//   · 접근성 라벨(aria-label/aria-describedby)은 호출부가 별도로 관리한다(여기선 시각 표시만).
//   · 네이티브 title 툴팁도 HoverTooltipProvider 가 이 말풍선(TooltipBubble)으로 통일한다.

type Placement = "top" | "bottom";

// 공통 말풍선 디자인(SoT) — 검정 배경 + 흰 글씨 + 둥근 모서리 + 그림자 + fade/scale 등장.
//   라이트/다크 모드에서 동일한 진한 배경(고정) — 어느 배경 위에서도 대비가 일정하도록 얇은 흰 테두리를 둔다.
//   이 컴포넌트(<Tooltip/>)와 네이티브 title 대체(HoverTooltipProvider)가 이 클래스를 공유한다.
export const TOOLTIP_BUBBLE_CLASS =
  "max-w-xs whitespace-normal break-words rounded-md bg-neutral-900 px-2.5 py-1.5 text-xs leading-snug text-white shadow-lg ring-1 ring-white/10 animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none";

// 트리거 사각형 기준 말풍선 좌표/배치 계산 — 위 공간이 부족하면 아래로 뒤집는다.
//   <Tooltip/> 과 HoverTooltipProvider 가 동일 규칙을 쓰도록 공용화한다.
export function computeTooltipCoords(el: Element): {
  top: number;
  left: number;
  placement: Placement;
} {
  const r = el.getBoundingClientRect();
  const gap = 8;
  const placement: Placement = r.top > 140 ? "top" : "bottom";
  const top = placement === "top" ? r.top - gap : r.bottom + gap;
  const left = r.left + r.width / 2;
  return { top, left, placement };
}

// 좌표/배치를 받아 body 로 portal 되는 말풍선.
//   위치 중앙정렬 transform 은 "바깥" 래퍼에, scale(zoom) 등장 애니메이션은 "안쪽" 말풍선에 둔다 →
//   zoom-in 애니메이션의 transform 이 중앙정렬 transform 과 충돌해 위치가 튀는 것을 막는다.
export function TooltipBubble({
  top,
  left,
  placement,
  id,
  className,
  children,
}: {
  top: number;
  left: number;
  placement: Placement;
  /** 접근성 연결용 id(aria-describedby 대상). 미지정이면 부여하지 않는다. */
  id?: string;
  /** 말풍선(안쪽) 추가 클래스. */
  className?: string;
  children: React.ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      style={{
        position: "fixed",
        top,
        left,
        transform:
          placement === "top" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
        zIndex: 60,
        pointerEvents: "none",
      }}
    >
      <div id={id} role="tooltip" className={cn(TOOLTIP_BUBBLE_CLASS, className)}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export type TooltipProps = {
  /** 툴팁에 표시할 내용. 비어 있으면(null/"") 표시하지 않는다. */
  content: React.ReactNode;
  /** 트리거(단일 요소 권장). 이 요소를 감싸는 inline wrapper 가 hover/focus 를 감지한다. */
  children: React.ReactNode;
  /** 열릴 때 1회 호출(도움말 lazy prefetch 등). */
  onOpen?: () => void;
  /** hover 후 표시까지 지연(ms). 기본 200. focus 는 즉시. */
  openDelay?: number;
  /** wrapper span 클래스(정렬/여백). */
  className?: string;
  /** 툴팁 말풍선 클래스. */
  contentClassName?: string;
};

export function Tooltip({
  content,
  children,
  onOpen,
  openDelay = 200,
  className,
  contentClassName,
}: TooltipProps) {
  const [open, setOpen] = React.useState(false);
  const [coords, setCoords] = React.useState<{
    top: number;
    left: number;
    placement: Placement;
  } | null>(null);
  const wrapRef = React.useRef<HTMLSpanElement>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // 언마운트 시 예약된 open 타이머 정리.
  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const computePosition = React.useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    setCoords(computeTooltipCoords(el));
  }, []);

  const doOpen = React.useCallback(() => {
    onOpen?.();
    computePosition();
    setOpen(true);
  }, [onOpen, computePosition]);

  const scheduleOpen = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(doOpen, openDelay);
  }, [doOpen, openDelay]);

  const close = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(false);
  }, []);

  // 열려 있는 동안 스크롤/리사이즈에 위치 추종.
  React.useEffect(() => {
    if (!open) return;
    const onMove = () => computePosition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, computePosition]);

  const show =
    open && content !== null && content !== undefined && content !== "";

  return (
    <span
      ref={wrapRef}
      className={cn("inline-flex align-middle", className)}
      onMouseEnter={scheduleOpen}
      onMouseLeave={close}
      onFocusCapture={doOpen}
      onBlurCapture={close}
    >
      {children}
      {show && coords && (
        <TooltipBubble
          top={coords.top}
          left={coords.left}
          placement={coords.placement}
          className={contentClassName}
        >
          {content}
        </TooltipBubble>
      )}
    </span>
  );
}

export default Tooltip;
