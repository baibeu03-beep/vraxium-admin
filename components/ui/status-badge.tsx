import * as React from "react"

import { Badge, BadgeButton, type BadgeTone } from "@/components/ui/badge"
import { TableCell } from "@/components/ui/table"
import { statusTone, valueTone } from "@/lib/statusBadge"
import { cn } from "@/lib/utils"

type BadgeSize = "sm" | "md" | "lg"

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge — 정규 라벨을 받아 레지스트리(lib/statusBadge)에서 색(tone)을 정해 렌더.
// 같은 라벨 = 같은 색을 보장한다. tone 을 직접 넘기면 레지스트리 대신 강제 적용.
// onClick(또는 interactive) 지정 시 클릭 가능한 BadgeButton 으로 렌더(상태 토글 등).
// ─────────────────────────────────────────────────────────────────────────────
type BadgeAppearance = "solid" | "soft" | "outline"

export function StatusBadge({
  label,
  tone,
  appearance = "solid",
  size = "md",
  className,
  title,
  onClick,
  disabled,
  interactive,
}: {
  label: React.ReactNode
  /** 레지스트리 자동 매핑 대신 강제할 tone(선택). */
  tone?: BadgeTone
  /** 시각적 비중 — solid(상태) · soft(품계) · outline(클래스). 기본 solid. */
  appearance?: BadgeAppearance
  size?: BadgeSize
  className?: string
  title?: string
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  interactive?: boolean
}) {
  // 라벨이 문자열일 때만 레지스트리 매핑. 노드(아이콘 등)면 default/override 사용.
  const resolved =
    tone ?? (typeof label === "string" ? statusTone(label) : "default")

  if (onClick || interactive) {
    return (
      <BadgeButton
        tone={resolved}
        appearance={appearance}
        size={size}
        className={className}
        title={title}
        onClick={onClick}
        disabled={disabled}
      >
        {label}
      </BadgeButton>
    )
  }

  return (
    <Badge
      tone={resolved}
      appearance={appearance}
      size={size}
      className={className}
      title={title}
    >
      {label}
    </Badge>
  )
}

// SelectBadge — 선택/열거값(액트 종류 필수/선별 등) 전용. 동작은 StatusBadge 와 동일하며,
// 호출부 가독성을 위해 의미를 분리해 둔다(같은 레지스트리·같은 색 규칙).
export function SelectBadge(props: React.ComponentProps<typeof StatusBadge>) {
  return <StatusBadge {...props} />
}

// ─────────────────────────────────────────────────────────────────────────────
// ValueBadge — "상태"가 아닌 **분류값**(소속 라인 급 · 체크 대상 · 카페 …)을 배지로.
// 색은 lib/statusBadge.valueTone(category, value) 이 값 자체로만 결정하므로,
// 정렬/필터/재렌더로 행 순서가 바뀌어도 같은 값은 항상 같은 색을 유지한다.
// 셀마다 색 조건문을 중복 작성하지 않기 위한 공용 진입점(SoT).
//
// 빈 값(null/""/"-")은 임의 색 배지를 만들지 않고 기존 빈 값 표기("-")를 그대로 쓴다.
// ─────────────────────────────────────────────────────────────────────────────
export function ValueBadge({
  category,
  value,
  size = "sm",
  appearance = "solid",
  className,
  emptyText = "-",
}: {
  /** 컬럼 스코프 — 같은 문자열이라도 컬럼이 다르면 다른 색 키가 된다. */
  category: string
  value: string | null | undefined
  size?: BadgeSize
  appearance?: BadgeAppearance
  className?: string
  emptyText?: string
}) {
  const v = (value ?? "").trim()
  if (!v || v === "-") {
    return <span className="text-muted-foreground">{emptyText}</span>
  }
  return (
    <Badge
      tone={valueTone(category, v)}
      appearance={appearance}
      size={size}
      className={cn("whitespace-nowrap", className)}
      title={v}
    >
      {v}
    </Badge>
  )
}

// TableCellBadge — 배지 컬럼용 TableCell. 가운데 정렬(요구사항 #6) + StatusBadge 렌더.
// label 만 넘기면 끝. tone/size/onClick 등은 그대로 위임.
export function TableCellBadge({
  className,
  cellClassName,
  ...badgeProps
}: React.ComponentProps<typeof StatusBadge> & {
  /** 배지 자체 className. */
  className?: string
  /** TableCell(셀) className. */
  cellClassName?: string
}) {
  return (
    <TableCell className={cn("text-center", cellClassName)}>
      <StatusBadge {...badgeProps} className={className} />
    </TableCell>
  )
}
