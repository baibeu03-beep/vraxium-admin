import * as React from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────────
// AppTable — 신규 표의 표준 진입점. 선언형 columns 만 넘기면
//   · 헤더 강조 · zebra · hover · padding(=base ui/table 기본)
//   · 프레임(테두리/라운드) · 정렬 · ellipsis
// 가 자동 적용된다. 페이지마다 CSS 복붙 없이 동일 스타일 보장.
//
// 배지 컬럼은 cell 에서 <StatusBadge/> 를 반환하고 align:"center" 로 두면 된다.
// ─────────────────────────────────────────────────────────────────────────────

export type AppTableColumn<T> = {
  /** React key + 내부 식별. */
  key: string
  /** 헤더 셀 내용. */
  header: React.ReactNode
  /** 본문 셀 렌더러. */
  cell: (row: T, index: number) => React.ReactNode
  align?: "left" | "center" | "right"
  /** 길면 … 처리(고정폭 필요 — width 와 함께 사용 권장). */
  truncate?: boolean
  /** CSS width(예: "12rem", "20%"). */
  width?: string
  /** 헤더/셀 공통 추가 className. */
  className?: string
  /** 헤더 셀에만 추가할 className. */
  headerClassName?: string
}

const alignClass = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
} as const

export function AppTable<T>({
  columns,
  rows,
  getRowKey,
  loading = false,
  loadingText = "불러오는 중…",
  empty = "데이터가 없습니다.",
  framed = true,
  rowClassName,
  className,
}: {
  columns: AppTableColumn<T>[]
  rows: T[]
  getRowKey: (row: T, index: number) => string
  loading?: boolean
  loadingText?: React.ReactNode
  empty?: React.ReactNode
  /** 테두리/라운드 프레임(기본 true). Card 안에 둘 때만 false 권장. */
  framed?: boolean
  rowClassName?: (row: T, index: number) => string | undefined
  className?: string
}) {
  const colCount = columns.length

  return (
    <div
      className={cn(
        framed && "overflow-hidden rounded-lg border border-border",
        className,
      )}
    >
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                className={cn(
                  col.align && alignClass[col.align],
                  col.truncate && "max-w-0",
                  col.className,
                  col.headerClassName,
                )}
              >
                {col.truncate ? (
                  <span className="block truncate">{col.header}</span>
                ) : (
                  col.header
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell
                colSpan={colCount}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                {loadingText}
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={colCount}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, i) => (
              <TableRow key={getRowKey(row, i)} className={rowClassName?.(row, i)}>
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    style={col.width ? { width: col.width } : undefined}
                    className={cn(
                      col.align && alignClass[col.align],
                      col.truncate && "max-w-0 truncate",
                      col.className,
                    )}
                  >
                    {col.cell(row, i)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
