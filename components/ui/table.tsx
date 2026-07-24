"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollAffordance } from "@/components/ui/scroll-affordance"
import { TablePagination } from "@/components/ui/table-pagination"
import { getTablePaginationState } from "@/lib/tablePagination"

function Table({
  className,
  containerRef,
  regionClassName,
  stickyLeft,
  pagination = "auto",
  children,
  ...props
}: React.ComponentProps<"table"> & {
  /** 스크롤 컨테이너 div 로 전달되는 ref — useStickyColumns 의 ref 를 여기 연결. */
  containerRef?: React.Ref<HTMLElement>
  /** 내부 스크롤러 className — 헤더 고정 시 "sticky-head-region"(useStickyColumns.regionClassName). */
  regionClassName?: string
  /** 왼쪽 열 고정 표 — 좌측 edge-fade 억제. */
  stickyLeft?: boolean
  /** 실제 목록 표는 기본 auto. 매트릭스·시간표·드래그 편집표만 명시적으로 off. */
  pagination?: "auto" | "off"
}) {
  const childArray = React.Children.toArray(children)
  const bodyIndex = childArray.findIndex(
    (child) => React.isValidElement(child) && child.type === TableBody,
  )
  const body =
    bodyIndex >= 0 && React.isValidElement<{ children?: React.ReactNode }>(childArray[bodyIndex])
      ? childArray[bodyIndex]
      : null
  const bodyRows = body ? React.Children.toArray(body.props.children) : []
  const rowSignature = bodyRows
    .map((row, index) => (React.isValidElement(row) && row.key != null ? row.key : index))
    .join("|")
  const [pageState, setPageState] = React.useState({ page: 1, signature: rowSignature })
  const requestedPage = pageState.signature === rowSignature ? pageState.page : 1
  const pageInfo = getTablePaginationState(bodyRows.length, requestedPage)
  const shouldPaginate = pagination === "auto" && pageInfo.showPagination

  const renderedChildren =
    shouldPaginate && body
      ? childArray.map((child, index) =>
          index === bodyIndex
            ? React.cloneElement(body, {
                children: bodyRows.slice(pageInfo.startIndex, pageInfo.endIndex),
              })
            : child,
        )
      : children

  return (
    <>
      {/* 가로 스크롤 인지 UX(가장자리 Fade + 첫 진입 힌트)를 모든 표에 기본 배선. */}
      <ScrollAffordance
        data-slot="table-container"
        className="w-full"
        containerClassName={regionClassName}
        stickyLeft={stickyLeft}
        innerRef={containerRef}
      >
        <table
          data-slot="table"
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        >
          {renderedChildren}
        </table>
      </ScrollAffordance>
      <TablePagination
        {...pageInfo}
        showPagination={shouldPaginate}
        onPageChange={(page) => setPageState({ page, signature: rowSignature })}
      />
    </>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      // 헤더 배경 강조 + 하단 구분선. 전역 기본(모든 테이블 자동 적용).
      className={cn(
        "bg-muted/60 [&_tr]:border-b [&_tr]:border-border",
        className,
      )}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      // zebra stripe — 짝수 행 옅은 배경(hover/selected 가 우선하도록 약하게).
      className={cn(
        "[&_tr:last-child]:border-0 [&_tr:nth-child(even)]:bg-muted/30",
        className,
      )}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-border/70 transition-colors hover:bg-accent/60 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // 전역 기본 정렬 = 가운데(text-center align-middle). 예외(긴 텍스트/로그/JSON/코드/메모 등)는
        // 호출부에서 text-left 를 주면 twMerge 가 우선 적용한다(개별 override 유지).
        // 셀 padding 통일(px-3) + 헤더는 약간 작은 muted 라벨로 가독성↑.
        "h-11 px-4 text-center align-middle text-sm font-semibold tracking-wide whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        // 전역 기본 정렬 = 가운데(text-center align-middle). 예외는 호출부 text-left override 유지.
        // 셀 padding 통일(px-4 py-2.5) — 커진 폰트 대비 가로 여백 확보.
        "px-4 py-2.5 text-center align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
