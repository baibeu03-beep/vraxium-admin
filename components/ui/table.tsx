"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { ScrollAffordance } from "@/components/ui/scroll-affordance"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    // 가로 스크롤 인지 UX(가장자리 Fade + 첫 진입 힌트)를 모든 표에 기본 배선.
    // 오버플로가 실제로 있을 때만 표시된다.
    <ScrollAffordance data-slot="table-container" className="w-full">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </ScrollAffordance>
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
        "h-11 px-3 text-center align-middle text-sm font-semibold tracking-wide whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0",
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
        // 셀 padding 통일(px-3 py-2.5).
        "px-3 py-2.5 text-center align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
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
