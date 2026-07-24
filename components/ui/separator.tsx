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
 *                모든 구분선에 자동 적용하지 말고 "큰 섹션 경계"에서만 명시적으로 사용한다.
 *
 * 색은 전부 테마 토큰(--border=라인, --muted-foreground=글리프)이라 라이트/다크 자동 지원.
 * ✦ 는 aria-hidden 이고 role="separator" 는 유지 → 스크린리더에 텍스트로 읽히지 않는다.
 * mode(일반/test)·org 분기 없음: 순수 프레젠테이션 컴포넌트로 전역 동일 렌더.
 *
 * 주의: 이 컴포넌트는 "의미적 구분선"만 담당한다. 테이블 행/셀, 카드 외곽선, 입력창
 * 테두리, sticky 바 경계 같은 "구조적" border-t/border-b 는 여기서 다루지 않는다.
 */
type SeparatorVariant = "fade" | "line" | "sparkle"

function Separator({
  className,
  orientation = "horizontal",
  variant = "fade",
  ...props
}: SeparatorPrimitive.Props & { variant?: SeparatorVariant }) {
  // sparkle 은 가로 섹션 경계 전용 장식이다. 세로 방향에서는 의미가 없으므로 fade 로 강등한다.
  const effective: SeparatorVariant =
    variant === "sparkle" && orientation === "vertical" ? "fade" : variant

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
