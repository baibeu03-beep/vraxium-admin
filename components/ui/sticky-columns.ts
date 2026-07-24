"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// useStickyColumns — 어드민 전역 표의 "왼쪽 식별 열 고정" 공통 훅.
//   페이지마다 sticky/left/z-index 클래스를 복붙하지 않고, 셀에 col(1)/col(2) 를
//   spread 하면 globals.css 의 .stick-col-* 계약이 동일 동작을 보장한다.
//
//   구조 불변식(핵심): col-1(체크박스/# 등 폭이 안정적인 리딩 열) 의 실측폭만
//   측정해 --sticky-col-1-w 로 발행한다. col-2(이름/팀명 등 가변 식별 열)는
//   width:auto 로 콘텐츠에 맞춰 흐르되, 같은 <table> 안이라 header/body/tfoot 의
//   같은 열은 폭을 공유한다 → 헤더/본문 정합이 구조적으로 보장되고, 고정폭 하드코딩
//   (left-16 같은 매직넘버)의 흔들림/불일치를 배제한다.
//
//   리딩 열이 없어 식별 열을 단독 고정하는 표는 col(2) 만 쓰면 된다
//   (--sticky-col-1-w 기본 0 → left:0).
//
//   ref 는 "고정 셀들을 포함하고 CSS 변수를 얹을" 스크롤 컨테이너(또는 <table>)에 건다.
//   primitive 표는 <Table ref={s.ref}> 가 ScrollAffordance 내부 스크롤 div 로 forward 하고,
//   원시 <table> 표는 <ScrollAffordance innerRef={s.ref}> 로 넘긴다.
//
//   상단 헤더 고정은 opt-in(headerSticky) — 내부 max-height 스크롤 영역이 필요하며
//   (페이지 스크롤 헤더 고정은 overflow-x 컨테이너에서 순수 CSS 불가), regionClassName
//   을 스크롤 컨테이너에 얹어 .sticky-head-region 을 켠다.
// ─────────────────────────────────────────────────────────────────────────────

export type StickyColIndex = 1 | 2

export type StickyColProps = {
  className: string
  "data-sticky-col": StickyColIndex
}

export type UseStickyColumns = {
  /** 스크롤 컨테이너(또는 <table>)에 거는 ref — col-1 실측폭을 이 요소의 --sticky-col-1-w 로 얹는다. */
  ref: React.RefObject<HTMLElement | null>
  /** headerSticky 시 스크롤 컨테이너에 얹을 className("sticky-head-region"), 아니면 "". */
  regionClassName: string
  /** 헤더/본문/요약 셀(th/td/TableHead/TableCell)에 spread — 예: <TableHead {...col(2)}>. */
  col: (n: StickyColIndex) => StickyColProps
}

export function useStickyColumns(opts?: {
  /** 상단 헤더 고정(내부 스크롤 영역) 활성 — 매우 긴 표에만. 기본 false. */
  headerSticky?: boolean
  /** headerSticky 시 내부 스크롤 영역 max-height(기본 70svh, CSS 변수로 주입). */
  maxHeight?: string
}): UseStickyColumns {
  const ref = React.useRef<HTMLElement | null>(null)
  const headerSticky = opts?.headerSticky ?? false
  const maxHeight = opts?.maxHeight

  // col-1 실측 → --sticky-col-1-w 발행. 없으면 0 유지(단독 고정 표).
  React.useEffect(() => {
    const host = ref.current
    if (!host) return

    // headerSticky 의 max-height override 를 컨테이너에 주입(계약 기본은 70svh).
    if (headerSticky && maxHeight) {
      host.style.setProperty("--sticky-head-max-h", maxHeight)
    }

    const measure = () => {
      const cell = host.querySelector<HTMLElement>('[data-sticky-col="1"]')
      const w = cell ? cell.getBoundingClientRect().width : 0
      host.style.setProperty("--sticky-col-1-w", `${w}px`)
    }
    measure()

    const ro = new ResizeObserver(measure)
    ro.observe(host)
    const cell = host.querySelector<HTMLElement>('[data-sticky-col="1"]')
    if (cell) ro.observe(cell)
    // 비동기 로드로 col-1 셀이 나중에 나타나는 경우(행 추가/필터) 재측정.
    const mo = new MutationObserver(measure)
    mo.observe(host, { childList: true, subtree: true })

    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [headerSticky, maxHeight])

  return {
    ref,
    regionClassName: headerSticky ? "sticky-head-region" : "",
    col: (n) => ({
      className: cn(n === 1 ? "stick-col-1" : "stick-col-2"),
      "data-sticky-col": n,
    }),
  }
}
