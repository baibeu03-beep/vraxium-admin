"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { ariaSortValue, type SortDirection } from "@/shared/detailLogSort";

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
}: {
  label: string;
  /** 이 컬럼의 현재 정렬 방향(활성 아니면 null). */
  dir: SortDirection | null;
  onSort: () => void;
  align?: "left" | "center";
  /** <th> 추가 클래스(폭·색 등). */
  className?: string;
}) {
  const next =
    dir === "asc"
      ? "오름차순 정렬됨. 누르면 내림차순."
      : dir === "desc"
        ? "내림차순 정렬됨. 누르면 기본 정렬로."
        : "정렬 안 됨. 누르면 오름차순.";
  return (
    <th
      aria-sort={ariaSortValue(dir)}
      className={cn("px-2 py-2 font-medium", align === "left" ? "text-left" : "text-center", className)}
    >
      <button
        type="button"
        onClick={onSort}
        aria-label={`${label} 기준 정렬 — ${next}`}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 hover:text-foreground",
          align === "left" ? "justify-start" : "w-full justify-center",
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
    </th>
  );
}
