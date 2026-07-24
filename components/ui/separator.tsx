"use client"

import { Separator as SeparatorPrimitive } from "@base-ui/react/separator"

import { cn } from "@/lib/utils"

/**
 * 구분선(Separator) — 공통 단일 소스.
 *
 * variant 로 위계를 선택한다(중복 컴포넌트 없이 하나로 관리, 공통 테마 토큰만 사용):
 *   · "fade"    (기본값) — 양끝이 자연스럽게 흐려지는 라인. 딱딱한 직선보다 부드럽다.
 *                기존 높이(1px)·여백·role="separator" 그대로 → 모든 사용처에 자동 적용.
 *   · "line"    — 기존의 균일한 1px 직선(이스케이프 해치). 균일 두께가 꼭 필요한 곳용.
 *   · "sparkle" — 최상위 섹션 경계 강조용. 가운데 ✦ 장식(라인보다 약간 진하게).
 *   · "wave"     — 은은한 연속 물결 장식. 얇은 두께(진폭 ~2.3px)·양끝 fade·정적(애니메이션 없음).
 *                 단순 직선보다 섹션 구분이 잘 읽히되 표 테두리처럼 딱딱하지 않다. 장식이므로
 *                 aria-hidden(스크린리더 비노출) — 섹션은 제목으로 이미 의미 분리됨. "큰 섹션 경계" 전용.
 *   · "wave-dot" — 좌우 얕은 물결 + 가운데 작은 점(～～ • ～～). 물결은 바깥쪽으로 fade,
 *                 가운데 점(foreground/32, 3.5px)이 초점을 준다. wave 와 동일하게 정적·aria-hidden.
 *
 * 색은 전부 테마 토큰(--border=라인, --muted-foreground=글리프, --foreground=물결)이라 라이트/다크 자동.
 * ✦·물결은 aria-hidden. mode(일반/test)·org 분기 없음: 순수 프레젠테이션 컴포넌트로 전역 동일 렌더.
 *
 * 주의: 이 컴포넌트는 "의미적 구분선"만 담당한다. 테이블 행/셀, 카드 외곽선, 입력창
 * 테두리, sticky 바 경계 같은 "구조적" border-t/border-b 는 여기서 다루지 않는다.
 */
type SeparatorVariant = "fade" | "line" | "sparkle" | "wave" | "wave-dot"

// 물결 마스크 — 정적 SVG 한 주기(period 18px, 진폭 ~2.3px, 둥근 끝)를 repeat-x 로 이어붙이고,
//   양끝 fade 는 가로 linear-gradient 마스크와 intersect 합성으로 만든다. 배경색(=물결 색)은
//   --foreground 20% 라 라이트/다크 자동. 색만 배경, 형태는 전부 mask(알파) → 테마 토큰 하나로 적응.
const WAVE_SVG_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='8'%3E%3Cpath d='M0 4 Q4.5 1.7 9 4 T18 4' fill='none' stroke='%23000' stroke-width='1.3' stroke-linecap='round'/%3E%3C/svg%3E\")"
const WAVE_MASK = `${WAVE_SVG_URL}, linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent)`
const WAVE_STYLE: React.CSSProperties = {
  height: "8px",
  backgroundColor: "color-mix(in oklch, var(--foreground) 20%, transparent)",
  WebkitMaskImage: WAVE_MASK,
  maskImage: WAVE_MASK,
  WebkitMaskRepeat: "repeat-x, no-repeat",
  maskRepeat: "repeat-x, no-repeat",
  WebkitMaskSize: "18px 8px, 100% 100%",
  maskSize: "18px 8px, 100% 100%",
  WebkitMaskPosition: "center, center",
  maskPosition: "center, center",
  WebkitMaskComposite: "source-in",
  maskComposite: "intersect",
}

// wave-dot: 좌우 물결 halves(각각 바깥쪽 끝만 fade, 안쪽=점 방향은 solid) + 가운데 점.
//   물결은 wave 보다 조금 더 연하게(foreground/18). 각 half 는 물결 mask ∩ 바깥끝 fade.
const waveHalfStyle = (side: "left" | "right"): React.CSSProperties => {
  const fadeGrad =
    side === "left"
      ? "linear-gradient(90deg, transparent, #000 40%, #000 100%)" // 바깥(좌) fade, 안쪽(우) solid
      : "linear-gradient(90deg, #000 0%, #000 60%, transparent)" //   안쪽(좌) solid, 바깥(우) fade
  const mask = `${WAVE_SVG_URL}, ${fadeGrad}`
  return {
    height: "8px",
    backgroundColor: "color-mix(in oklch, var(--foreground) 18%, transparent)",
    WebkitMaskImage: mask,
    maskImage: mask,
    WebkitMaskRepeat: "repeat-x, no-repeat",
    maskRepeat: "repeat-x, no-repeat",
    WebkitMaskSize: "18px 8px, 100% 100%",
    maskSize: "18px 8px, 100% 100%",
    WebkitMaskPosition: "center, center",
    maskPosition: "center, center",
    WebkitMaskComposite: "source-in",
    maskComposite: "intersect",
  }
}
const WAVE_HALF_LEFT = waveHalfStyle("left")
const WAVE_HALF_RIGHT = waveHalfStyle("right")
const WAVE_DOT_STYLE: React.CSSProperties = {
  width: "3.5px",
  height: "3.5px",
  borderRadius: "9999px",
  flex: "none",
  backgroundColor: "color-mix(in oklch, var(--foreground) 32%, transparent)",
}

function Separator({
  className,
  orientation = "horizontal",
  variant = "fade",
  ...props
}: SeparatorPrimitive.Props & { variant?: SeparatorVariant }) {
  // sparkle·wave·wave-dot 은 가로 섹션 경계 전용 장식이다. 세로 방향에서는 의미가 없어 fade 로 강등한다.
  const effective: SeparatorVariant =
    (variant === "sparkle" || variant === "wave" || variant === "wave-dot") &&
    orientation === "vertical"
      ? "fade"
      : variant

  if (effective === "wave-dot") {
    // 좌우 물결 half + 가운데 점. gap-3(12px) 이 물결↔점 여백. style(mask)에 의존하므로 일반 div.
    return (
      <div
        data-slot="separator"
        data-variant="wave-dot"
        role="separator"
        aria-orientation={orientation}
        aria-hidden
        className={cn(
          "flex w-full shrink-0 items-center justify-center gap-3 border-0 bg-transparent",
          className,
        )}
      >
        <span aria-hidden className="h-2 flex-1" style={WAVE_HALF_LEFT} />
        <span aria-hidden style={WAVE_DOT_STYLE} />
        <span aria-hidden className="h-2 flex-1" style={WAVE_HALF_RIGHT} />
      </div>
    )
  }

  if (effective === "wave") {
    // 물결은 인라인 style(mask)에 전적으로 의존하므로, style 전달이 확실한 일반 div 로 렌더한다
    //   (role="separator"·aria-hidden 유지 — 장식, 스크린리더 비노출). style 우선(뒤에 배치)해 덮이지 않게.
    return (
      <div
        data-slot="separator"
        data-variant="wave"
        role="separator"
        aria-orientation={orientation}
        aria-hidden
        className={cn("w-full shrink-0 border-0 bg-transparent", className)}
        style={WAVE_STYLE}
      />
    )
  }

  if (effective === "sparkle") {
    return (
      <SeparatorPrimitive
        data-slot="separator"
        data-variant="sparkle"
        orientation={orientation}
        className={cn(
          // 라인(::before/::after) + 가운데 글리프. gap 이 좌우 라인과 ✦ 사이 여백.
          "flex w-full shrink-0 items-center gap-3 border-0 bg-transparent text-muted-foreground",
          "before:h-px before:flex-1 before:[background-image:linear-gradient(90deg,transparent,var(--border)_45%,var(--border))] before:content-['']",
          "after:h-px after:flex-1 after:[background-image:linear-gradient(270deg,transparent,var(--border)_45%,var(--border))] after:content-['']",
          className
        )}
        {...props}
      >
        <span aria-hidden className="text-[13px] leading-none">
          ✦
        </span>
      </SeparatorPrimitive>
    )
  }

  return (
    <SeparatorPrimitive
      data-slot="separator"
      data-variant={effective}
      orientation={orientation}
      className={cn(
        "shrink-0",
        // 세로/가로 공통 두께 규칙(기존과 동일: 1px, full).
        "data-horizontal:h-px data-horizontal:w-full data-vertical:w-px data-vertical:self-stretch",
        effective === "line"
          ? // 기존의 균일 직선.
            "bg-border"
          : // fade: 양끝이 투명으로 사라지는 라인. 가운데는 기존과 동일한 border 두께/색 →
            // 무게감은 그대로 두고 끝만 부드럽게. 방향에 맞춰 그라데이션 축을 바꾼다.
            "bg-transparent data-horizontal:[background-image:linear-gradient(90deg,transparent,var(--border)_22%,var(--border)_78%,transparent)] data-vertical:[background-image:linear-gradient(180deg,transparent,var(--border)_22%,var(--border)_78%,transparent)]",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
export type { SeparatorVariant }
