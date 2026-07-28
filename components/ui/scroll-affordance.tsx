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
//   [세로 내부 스크롤 안내] headerSticky(.sticky-head-region) 표는 overscroll-behavior:contain
//   때문에 "스크롤할 내용이 없어도" 휠 입력이 페이지로 체이닝되지 않는다. 행이 적어
//   scrollHeight <= clientHeight 인 상태에서 표 위에 커서를 두고 휠을 돌리면 페이지가
//   멈춘 것처럼 보이므로, 그 상황에서만 표 상단(헤더 행 우측)에 muted 배지를 잠깐 띄워
//   "스크롤 이동은 표 바깥에서" 라는 사실만 알린다. 제목 바로 아래 = 사용자의 시선/커서와
//   가까운 위치이며, 제목 텍스트나 우측 버튼 줄은 가리지 않는다(표 컨테이너 안에서만 표시).
//   ⚠ wheel 이벤트는 관찰만 한다 — preventDefault/window.scrollBy 등 스크롤 개입 금지.
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

  // 세로 내부 스크롤 영역(headerSticky)에서만 "표 바깥에서 스크롤" 안내를 배선한다.
  const verticalRegion = (containerClassName ?? "").includes("sticky-head-region")
  const [showPageScrollNote, setShowPageScrollNote] = React.useState(false)
  const noteTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  // 휠 입력 관찰(가로채지 않음) — 실제로 세로 스크롤 여지가 없을 때만 안내를 띄우고,
  // 연속 입력 시에는 끄지 않고 타이머만 연장한다(깜빡임 방지).
  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!verticalRegion) return
      if (event.deltaY === 0) return
      const el = scrollRef.current
      if (!el) return
      // 1px 여유 — 서브픽셀 반올림으로 인한 오판정 방지.
      if (el.scrollHeight - el.clientHeight > 1) return
      setShowPageScrollNote(true)
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
      noteTimerRef.current = setTimeout(() => setShowPageScrollNote(false), 1800)
    },
    [verticalRegion],
  )

  React.useEffect(() => {
    return () => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    }
  }, [])

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
          // 실제로 내부 스크롤이 일어났다면 안내는 즉시 불필요.
          if (showPageScrollNote) setShowPageScrollNote(false)
          measure()
        }}
        onWheel={handleWheel}
        className={cn("admin-table-scroll w-full overflow-x-auto", containerClassName)}
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

      {/* 세로 내부 스크롤 여지가 없는 표 위에서 휠을 돌렸을 때만 뜨는 안내 배지.
          해당 표 컨테이너 상단 우측 고정(제목 바로 아래 · 헤더 행 높이 안) — 커서를
          따라다니지 않고, 오류가 아닌 muted 톤 · 반투명 pill.
          연속 휠 입력에서는 타이머만 연장되어 깜빡이지 않는다.
          ⚠ 레이어는 --z-page-popover — sticky thead/corner 위, 모달 backdrop 아래. */}
      {verticalRegion && (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1.5 right-3 z-page-popover rounded-full border border-border/60 bg-background/85 px-2.5 py-0.5 text-2xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-300",
            showPageScrollNote ? "opacity-100" : "opacity-0",
          )}
        >
          스크롤 이동은 표 바깥에서 해주세요.
        </div>
      )}
    </div>
  )
}
