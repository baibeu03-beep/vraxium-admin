"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ariaSortValue, type SortDirection } from "@/shared/detailLogSort";
import type { StickyColProps } from "@/components/ui/sticky-columns";

// 정렬 가능한 <th> — 주차 상세 "액트 체크 내역"·"라인 강화 내역" 표 공용(어드민).
//   · 3단계 순환(없음 → 오름차순 → 내림차순 → 기본)은 상위(cycleSort)가 관리하고, 여기선 표시만.
//   · 접근성: th[aria-sort] + 실제 <button>(키보드 Enter/Space) + 상태를 담은 aria-label
//     (아이콘만으로 의미를 전달하지 않는다). 크루 /cluster-4-card Detail Log 와 동일 UX 규칙.
export function SortableTh({
  label,
  dir,
  onSort,
  align = "center",
  className,
  sticky,
  help,
}: {
  label: string;
  /** 이 컬럼의 현재 정렬 방향(활성 아니면 null). */
  dir: SortDirection | null;
  onSort: () => void;
  align?: "left" | "center";
  /** <th> 추가 클래스(폭·색 등). */
  className?: string;
  /** 좌측 열 고정 계약(useStickyColumns().col(n)) — 지정 시 이 <th> 를 고정 열로. 기본 undefined. */
  sticky?: StickyColProps;
  /** 라벨 옆 도움말(돋보기) 등 부가 요소 — 정렬 버튼의 형제로 렌더(클릭이 정렬을 트리거하지 않음). */
  help?: ReactNode;
}) {
  const next =
    dir === "asc"
      ? "오름차순 정렬됨. 누르면 내림차순."
      : dir === "desc"
        ? "내림차순 정렬됨. 누르면 기본 정렬로."
        : "정렬 안 됨. 누르면 오름차순.";
  const button = (
    <button
      type="button"
      onClick={onSort}
      aria-label={`${label} 기준 정렬 — ${next}`}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 hover:text-foreground",
        align === "left" ? "justify-start" : "justify-center",
        // help 이 있으면 래퍼(span)가 폭/정렬을 담당하므로 버튼 w-full 을 주지 않는다.
        !help && align === "center" && "w-full",
        dir && "text-foreground",
      )}
    >
      <span>{label}</span>
      {dir === "asc" ? (
        <ArrowUp className="h-3 w-3" aria-hidden />
      ) : dir === "desc" ? (
        <ArrowDown className="h-3 w-3" aria-hidden />
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
      )}
    </button>
  );
  return (
    <th
      aria-sort={ariaSortValue(dir)}
      data-sticky-col={sticky?.["data-sticky-col"]}
      className={cn("px-2 py-2 font-medium", align === "left" ? "text-left" : "text-center", className, sticky?.className)}
    >
      {help != null ? (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            align === "center" && "w-full justify-center",
          )}
        >
          {button}
          {help}
        </span>
      ) : (
        button
      )}
    </th>
  );
}
