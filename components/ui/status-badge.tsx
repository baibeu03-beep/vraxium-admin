import * as React from "react"

import { Badge, BadgeButton, type BadgeTone } from "@/components/ui/badge"
import { TableCell } from "@/components/ui/table"
import { statusTone } from "@/lib/statusBadge"
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
