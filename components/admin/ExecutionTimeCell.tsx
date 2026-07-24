import * as React from "react"

import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionTimeCell — "이행 시점" 통합 셀. 신청 시점 + 검수 시점을 한 열 안에서
//   위아래 2행(신청/검수 라벨 + 값)으로 표시한다. 어드민 표 3곳 공용(복붙 금지).
//
//   원천 필드/정렬은 표별로 그대로 두고, 화면 표시만 조합한다(DTO/API 무변경).
//   값이 없으면 "—". 라벨은 값과 구분되도록 작은 muted 배지로 렌더.
//
//   사용처: ProcessCheckActTable(필요·실제), ProcessUnifiedManager(필요),
//           ProcessIrregularManager(실제).
// ─────────────────────────────────────────────────────────────────────────────

function isEmpty(v: React.ReactNode): boolean {
  return v === null || v === undefined || v === "" || v === "—" || v === "-"
}

function ExecutionTimeRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}) {
  const empty = isEmpty(value)
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-2xs font-semibold text-muted-foreground">
        {label}
      </span>
      <span className={cn("tabular-nums", empty && "text-muted-foreground")}>
        {empty ? "—" : value}
      </span>
    </div>
  )
}

export default function ExecutionTimeCell({
  apply,
  review,
  className,
}: {
  /** 신청 시점 표시값(문자열/노드). 없으면 "—". */
  apply: React.ReactNode
  /** 검수 시점 표시값(문자열/노드). 없으면 "—". */
  review: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex min-w-[9rem] flex-col gap-1 text-left", className)}>
      <ExecutionTimeRow label="신청" value={apply} />
      <ExecutionTimeRow label="검수" value={review} />
    </div>
  )
}
