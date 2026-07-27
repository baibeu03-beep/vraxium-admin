"use client";

import { useCallback, useMemo, useState } from "react";
import { cycleSort, type SortDirection } from "@/shared/detailLogSort";
import {
  sortTableRows,
  type TableSortColumns,
  type TableSortState,
} from "@/lib/adminTableSort";

// 어드민 표 컬럼 정렬 공용 훅 — <SortableTh> 와 짝을 이룬다.
//   · 3단계 순환(오름차순 → 내림차순 → 기본 복원)은 shared/detailLogSort.cycleSort 그대로.
//   · 비교 규칙(문자/숫자/날짜/불리언·null 최하단·안정 정렬)은 lib/adminTableSort SoT 그대로.
//   · 정렬은 **표시 순서만** 바꾼다 — 행 데이터/DTO/요약값은 건드리지 않는다.
//
// ⚠ columns 는 매 렌더 새 객체를 만들지 말고 useMemo(또는 모듈 상수)로 안정화할 것
//   (그래야 정렬 결과 메모가 유지된다).
export function useTableColumnSort<T, K extends string>(
  rows: readonly T[],
  columns: TableSortColumns<T, K>,
) {
  const [sort, setSort] = useState<TableSortState<K>>(null);

  const onSort = useCallback((key: K) => {
    setSort((prev) => cycleSort(prev, key));
  }, []);

  const dirOf = useCallback(
    (key: K): SortDirection | null => (sort?.key === key ? sort.dir : null),
    [sort],
  );

  const sortedRows = useMemo(
    () => sortTableRows(rows, sort, columns),
    [rows, sort, columns],
  );

  return { sort, setSort, onSort, dirOf, sortedRows };
}
