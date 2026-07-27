"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// AnchoredPortalMenu — 앵커(입력/버튼) 기준으로 **body 에 portal 되는** 드롭다운 공통 계약.
//
//   왜 portal 인가(원인 두 가지 — z-index 만 올려서는 해결되지 않는다):
//     ① clipping  : 어드민 공용 Card(components/ui/card.tsx)는 base 클래스에 overflow-hidden 이
//                    들어 있다(rounded-xl 안쪽 이미지/표 모서리 처리를 위해 의도된 것). 카드 안에서
//                    position:absolute 로 띄운 메뉴는 카드 경계에서 그대로 잘린다.
//     ② stacking  : 표의 sticky 셀은 globals.css 의 단일 z 스케일(일반 0 < 좌측 고정 20 <
//                    상단 헤더 30 < 좌상단 corner 40)을 쓴다. 카드/섹션 조상에 stacking context 를
//                    만드는 속성(transform·filter·opacity<1·isolation·contain)이 하나도 없으므로
//                    메뉴와 sticky 셀이 **같은 root stacking context** 에서 z 값만으로 겨룬다.
//                    → 카드 안 absolute 메뉴는 표 헤더(30)·corner(40) 아래로 깔린다.
//
//   메뉴를 body 로 옮기면 조상 clipping/stacking 자체에서 분리되므로 두 원인이 동시에 사라진다.
//   좌표는 앵커 rect 기반 fixed — 스크롤/리사이즈 시 재계산해 앵커를 따라간다.
//   (동일 패턴 선례: LineRegistrationInfoManager 의 허브 필터 메뉴.)
//
//   바깥 클릭 닫기는 앵커·메뉴 **둘 다** 명시 검사한다 — portal 로 DOM 이 분리돼 있어
//   앵커 contains 만으로는 메뉴 내부 클릭이 "바깥"으로 오판되고, mousedown 에서 닫히면
//   항목의 onClick 이 발화하기 전에 언마운트된다.
// ─────────────────────────────────────────────────────────────────────────────

/** portal 팝오버 레이어. globals.css sticky 스케일(최대 corner 40)과 shadcn 팝오버(50) 위. */
export const ANCHORED_MENU_Z = 60

export type AnchoredMenuPos = { top: number; left: number; width: number }

// SSR 안전 layout effect — 서버 렌더 경로에서 useLayoutEffect 경고를 내지 않는다.
//   클라이언트에서는 페인트 전에 좌표를 잡아 "0,0 에서 제자리로 튀는" 첫 프레임을 없앤다.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

export function AnchoredPortalMenu({
  open,
  anchorRef,
  onClose,
  minWidth = 0,
  offset = 4,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** 열림 여부 — false 면 아무것도 렌더하지 않는다. */
  open: boolean
  /** 위치/너비 기준이 되는 앵커 요소(보통 입력 wrapper 또는 trigger 버튼). */
  anchorRef: React.RefObject<HTMLElement | null>
  /** 바깥 클릭·Esc 로 닫힘 요청. */
  onClose: () => void
  /** 앵커보다 좁아지지 않게 할 최소 너비(px). 기본 0 = 앵커 너비 그대로. */
  minWidth?: number
  /** 앵커 아래 간격(px). 기본 4 = 기존 mt-1 과 동일. */
  offset?: number
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<AnchoredMenuPos | null>(null)

  const compute = React.useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ top: r.bottom + offset, left: r.left, width: Math.max(r.width, minWidth) })
  }, [anchorRef, minWidth, offset])

  // 열릴 때 즉시 1회 측정 — 첫 페인트부터 제자리에 뜨게 한다.
  useIsoLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    compute()
  }, [open, compute])

  // 열린 동안 스크롤(캡처 — 내부 스크롤 컨테이너 포함)/리사이즈 → 좌표 재계산.
  React.useEffect(() => {
    if (!open) return
    const onMove = () => compute()
    window.addEventListener("scroll", onMove, true)
    window.addEventListener("resize", onMove)
    return () => {
      window.removeEventListener("scroll", onMove, true)
      window.removeEventListener("resize", onMove)
    }
  }, [open, compute])

  // 바깥 클릭 / Esc 로 닫기. 앵커·메뉴 내부는 무시(위 주석의 portal 계약).
  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (anchorRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, anchorRef, onClose])

  if (!open || !pos || typeof document === "undefined") return null

  return createPortal(
    <div
      ref={menuRef}
      data-slot="anchored-portal-menu"
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: ANCHORED_MENU_Z,
      }}
      className={cn("rounded-md border bg-background shadow-md", className)}
      {...props}
    >
      {children}
    </div>,
    document.body,
  )
}
