"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// ScrollAffordance — 가로 스크롤 인지(affordance) 공통 래퍼.
//   관리자 표/통계 스트립처럼 폰트 확대로 가로 오버플로가 생길 때, 사용자가
//   "옆으로 더 볼 수 있다"는 사실을 자연스럽게 인지하도록 돕는다.
//
//   · 실제로 오버플로가 있을 때만 표시(오버플로 없으면 아무것도 안 나옴 — 요구사항).
//   · 스크롤 위치에 따라 좌/우 가장자리 Fade Shadow 를 켠다(끝에 닿으면 해당 쪽 사라짐).
//   · 첫 진입 시 우하단에 은은한 "← 좌우로 스크롤 →" 힌트 — 한 번 스크롤하면 사라진다.
//   · 내용 변화(행 추가/삭제)·리사이즈를 관찰해 상태를 갱신한다.
//
//   공통 Table 컨테이너에 기본 배선되어 모든 표가 자동으로 얻는다. 원시 <table>
//   이나 상단 통계 스트립 등에는 이 컴포넌트로 감싸 동일 UX 를 적용한다.
// ─────────────────────────────────────────────────────────────────────────────

export function ScrollAffordance({
  className,
  containerClassName,
  hint = true,
  hintLabel = "좌우로 스크롤",
  stickyLeft = false,
  innerRef,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** 내부 스크롤러(overflow-x-auto)에 추가할 className. */
  containerClassName?: string
  /** 첫 진입 힌트 표시 여부(기본 true). */
  hint?: boolean
  /** 힌트 문구(기본 "좌우로 스크롤"). */
  hintLabel?: React.ReactNode
  /** 왼쪽 열 고정 표 — 좌측 edge-fade 를 억제한다(고정 밴드가 있으면 왼쪽 힌트가 무의미·충돌). */
  stickyLeft?: boolean
  /** 내부 스크롤 div 로 전달할 ref — useStickyColumns 가 여기에 --sticky-col-1-w 를 얹는다. */
  innerRef?: React.Ref<HTMLElement>
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ left: false, right: false })
  const [interacted, setInteracted] = React.useState(false)

  // 외부 innerRef 를 내부 scrollRef 와 병합(측정용 훅과 어포던스 로직이 같은 div 를 참조).
  const setScrollNode = React.useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node
      if (typeof innerRef === "function") innerRef(node)
      else if (innerRef) (innerRef as React.RefObject<HTMLElement | null>).current = node
    },
    [innerRef],
  )

  const measure = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    const max = scrollWidth - clientWidth
    // 1px 여유 — 서브픽셀 반올림으로 인한 헛 fade 방지.
    setEdges({ left: scrollLeft > 1, right: scrollLeft < max - 1 })
  }, [])

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    // 행 추가/삭제 등 내용 변화도 재측정(비동기 로드 후 폭 변화 대응).
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true })
    window.addEventListener("resize", measure)
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [measure])

  const scrollable = edges.left || edges.right
  const showHint = hint && scrollable && !interacted

  return (
    <div className={cn("relative", className)} {...props}>
      <div
        ref={setScrollNode}
        onScroll={() => {
          if (!interacted) setInteracted(true)
          measure()
        }}
        className={cn("w-full overflow-x-auto", containerClassName)}
      >
        {children}
      </div>

      {/* 좌/우 가장자리 Fade — 스크롤 여지가 있는 쪽만 켜진다.
          왼쪽 열 고정(stickyLeft) 표에서는 좌측 fade 를 억제 — 고정 밴드가 이미 좌측을
          덮으므로 "왼쪽에 더 있다"는 힌트가 무의미하고 고정 셀을 흐리게 덮는 충돌을 낳는다. */}
      {!stickyLeft && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent transition-opacity duration-200",
            edges.left ? "opacity-100" : "opacity-0",
          )}
        />
      )}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent transition-opacity duration-200",
          edges.right ? "opacity-100" : "opacity-0",
        )}
      />

      {/* 첫 진입 힌트 — 실제 오버플로 시에만, 한 번 스크롤하면 사라진다. */}
      {hint && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute right-2 bottom-2 z-10 inline-flex items-center gap-1 rounded-full border border-border bg-background/90 px-2 py-0.5 text-2xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-300",
            showHint ? "opacity-100" : "opacity-0",
          )}
        >
          <span aria-hidden>←</span>
          {hintLabel}
          <span aria-hidden>→</span>
        </div>
      )}
    </div>
  )
}
