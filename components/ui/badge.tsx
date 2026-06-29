import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// 상태/선택값 색상 그룹화의 단일 스타일 소스. tone 토큰(globals.css --badge-*)만 참조해
// 라이트/다크 모두 자동 대응한다. 색 매핑은 lib/statusBadge 레지스트리가 담당하고,
// 이 컴포넌트는 "어떻게 그릴지"만 안다(라벨→tone 결정은 레지스트리 책임).
export const badgeVariants = cva(
  // tone 은 색(hue)을 CSS 변수(--bt-*)로만 설정하고, appearance 가 그 변수를 얼마나
  // 강하게 쓸지(solid/soft/outline) 결정한다 → 같은 색을 시각적 비중만 다르게 재사용.
  "inline-flex shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md border font-medium leading-none transition-colors [&_svg]:pointer-events-none [&_svg]:size-3",
  {
    variants: {
      tone: {
        success:
          "[--bt-fg:var(--badge-success-fg)] [--bt-bg:var(--badge-success-bg)] [--bt-bd:var(--badge-success-border)]",
        danger:
          "[--bt-fg:var(--badge-danger-fg)] [--bt-bg:var(--badge-danger-bg)] [--bt-bd:var(--badge-danger-border)]",
        warning:
          "[--bt-fg:var(--badge-warning-fg)] [--bt-bg:var(--badge-warning-bg)] [--bt-bd:var(--badge-warning-border)]",
        info: "[--bt-fg:var(--badge-info-fg)] [--bt-bg:var(--badge-info-bg)] [--bt-bd:var(--badge-info-border)]",
        neutral:
          "[--bt-fg:var(--badge-neutral-fg)] [--bt-bg:var(--badge-neutral-bg)] [--bt-bd:var(--badge-neutral-border)]",
        violet:
          "[--bt-fg:var(--badge-violet-fg)] [--bt-bg:var(--badge-violet-bg)] [--bt-bd:var(--badge-violet-border)]",
        orange:
          "[--bt-fg:var(--badge-orange-fg)] [--bt-bg:var(--badge-orange-bg)] [--bt-bd:var(--badge-orange-border)]",
        // default = 약한 중립(매핑되지 않은 라벨 폴백).
        default:
          "[--bt-fg:var(--muted-foreground)] [--bt-bg:var(--muted)] [--bt-bd:var(--border)]",
      },
      // 시각적 비중 — 상태=solid(가장 강함) · 품계=soft(옅은 채움) · 클래스=outline(가장 은은).
      appearance: {
        solid:
          "border-[var(--bt-bd)] bg-[var(--bt-bg)] text-[var(--bt-fg)]",
        soft: "border-transparent bg-[var(--bt-bg)]/55 text-[var(--bt-fg)]",
        outline:
          "bg-transparent text-foreground/70 border-[var(--bt-bd)]/55",
      },
      size: {
        sm: "px-1.5 py-0.5 text-2xs",
        md: "px-2.5 py-1 text-xs",
        lg: "px-3 py-1.5 text-sm",
      },
      // 버튼처럼 클릭 가능한 배지(체크 신청 등)에 hover/disabled 상호작용 부여.
      interactive: {
        true: "cursor-pointer hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:brightness-110",
        false: "",
      },
    },
    defaultVariants: {
      tone: "default",
      appearance: "solid",
      size: "md",
      interactive: false,
    },
  },
)

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>

function Badge({
  className,
  tone,
  appearance,
  size,
  interactive,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      className={cn(
        badgeVariants({ tone, appearance, size, interactive }),
        className,
      )}
      {...props}
    />
  )
}

// 클릭 가능한 배지(상태 토글 버튼). interactive 기본 true.
function BadgeButton({
  className,
  tone,
  appearance,
  size,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof badgeVariants>) {
  return (
    <button
      type={type}
      data-slot="badge-button"
      className={cn(
        badgeVariants({ tone, appearance, size, interactive: true }),
        className,
      )}
      {...props}
    />
  )
}

export { Badge, BadgeButton }
