"use client";

import * as React from "react";
import {
  TooltipBubble,
  computeTooltipCoords,
} from "@/components/ui/tooltip";

// 전역 Hover Tooltip Provider — 어드민 전체의 "네이티브 title" 툴팁을 공통 디자인으로 통일한다.
//   왜 필요한가: 프로젝트 전반에 흩어진 title="..." 은 브라우저 기본(흰색) 툴팁으로 떠서 디자인이 제각각이다.
//   개별 파일 수백 곳을 고치는 대신, 여기 한 곳에서 title 을 런타임에 가로채:
//     (1) 네이티브 title 을 잠시 제거해 브라우저 기본 툴팁을 억제하고,
//     (2) 공통 말풍선(TooltipBubble, 검정 배경·흰 글씨·둥근 모서리·그림자·fade/scale)을 대신 띄운다.
//   레이아웃 한 곳(portal layout)에만 마운트한다 → /admin/* 전역 적용. mode/org 로 갈리지 않는다.
//
//   접근성: hover/focus 중에는 title 을 떼는 대신 aria-describedby 로 커스텀 말풍선을 연결하고,
//     떠날 때 title 을 원복한다(평상시 DOM 에 title 이 남아 스크린리더가 읽는다).
//   모바일: hover 이벤트가 없어 발동하지 않는다(네이티브 title 도 원래 안 뜸) → 기존 동작 유지.
//   <Tooltip/>(도움말 아이콘 등)은 트리거에 title 이 없고 커스텀 말풍선을 직접 쓰므로 이 provider 와 겹치지 않는다.

const TOOLTIP_ID = "admin-hover-tooltip";
const OPEN_DELAY = 200; // hover 표시 지연(ms). focus 는 즉시.

type ShownState = {
  text: string;
  top: number;
  left: number;
  placement: "top" | "bottom";
};

export default function HoverTooltipProvider() {
  const [shown, setShown] = React.useState<ShownState | null>(null);

  // 현재 활성(툴팁 대상) 요소 + 원복할 원래 title. 렌더와 무관한 mutable 상태라 ref 로 둔다.
  const activeElRef = React.useRef<HTMLElement | null>(null);
  const originalTitleRef = React.useRef<string | null>(null);
  // title 이 유일한 접근성 이름이었던 요소에 임시로 aria-label 을 부여했는지(원복 시 제거 판단용).
  const addedAriaLabelRef = React.useRef(false);
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const hide = React.useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    const el = activeElRef.current;
    if (el) {
      const original = originalTitleRef.current;
      // 네이티브 title 원복(억제 해제) — 그 사이 React 가 다시 넣지 않았을 때만.
      if (original != null && !el.getAttribute("title")) {
        el.setAttribute("title", original);
      }
      if (el.getAttribute("aria-describedby") === TOOLTIP_ID) {
        el.removeAttribute("aria-describedby");
      }
      // 우리가 임시로 넣은 aria-label 만 제거(요소가 원래 갖고 있던 라벨은 건드리지 않는다).
      if (addedAriaLabelRef.current && el.getAttribute("aria-label") === original) {
        el.removeAttribute("aria-label");
      }
    }
    activeElRef.current = null;
    originalTitleRef.current = null;
    addedAriaLabelRef.current = false;
    setShown(null);
  }, []);

  const showFor = React.useCallback(
    (el: HTMLElement, immediate: boolean) => {
      if (activeElRef.current === el) return; // 이미 이 요소가 활성
      const title = el.getAttribute("title");
      if (!title || !title.trim()) return;

      if (activeElRef.current) hide(); // 다른 요소로 전환 — 이전 정리

      activeElRef.current = el;
      originalTitleRef.current = title;
      // 네이티브 title 억제(제거) + 접근성 유지(커스텀 말풍선을 aria-describedby 로 연결).
      el.removeAttribute("title");
      el.setAttribute("aria-describedby", TOOLTIP_ID);
      // title 이 유일한 접근성 이름이던 요소(아이콘 전용 버튼 등)는 title 제거로 이름을 잃는다 →
      //   이름이 따로 없을 때만 임시 aria-label 로 보존(원래 라벨/텍스트가 있으면 손대지 않는다).
      const hasName =
        !!el.getAttribute("aria-label") ||
        !!el.getAttribute("aria-labelledby") ||
        !!el.textContent?.trim();
      if (!hasName) {
        el.setAttribute("aria-label", title);
        addedAriaLabelRef.current = true;
      } else {
        addedAriaLabelRef.current = false;
      }

      const reveal = () => {
        openTimerRef.current = null;
        if (activeElRef.current !== el) return;
        setShown({ text: title, ...computeTooltipCoords(el) });
      };
      if (immediate) {
        reveal();
      } else {
        if (openTimerRef.current) clearTimeout(openTimerRef.current);
        openTimerRef.current = setTimeout(reveal, OPEN_DELAY);
      }
    },
    [hide],
  );

  React.useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // 현재 활성 요소 내부에서의 이동은 무시(title 을 떼면 closest 가 조상 title 로 튀는 것을 방지).
      if (activeElRef.current && activeElRef.current.contains(t)) return;
      const el = t.closest?.("[title]") as HTMLElement | null;
      if (!el) return;
      showFor(el, false);
    };
    const onOut = (e: MouseEvent) => {
      const el = activeElRef.current;
      if (!el) return;
      const related = e.relatedTarget as Node | null;
      // 여전히 활성 요소 안(자식)으로 이동한 것이면 유지.
      if (related && el.contains(related)) return;
      hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      const el = t?.closest?.("[title]") as HTMLElement | null;
      if (!el) return;
      showFor(el, true); // 키보드 포커스는 즉시
    };
    const onFocusOut = () => hide();
    const onScroll = () => hide();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    // capture=true 로 실제 스크롤 컨테이너(main)의 스크롤도 잡는다.
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown, true);
      hide();
    };
  }, [showFor, hide]);

  if (!shown) return null;
  return (
    <TooltipBubble
      id={TOOLTIP_ID}
      top={shown.top}
      left={shown.left}
      placement={shown.placement}
    >
      {shown.text}
    </TooltipBubble>
  );
}
