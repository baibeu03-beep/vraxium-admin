"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  getTablePaginationState,
} from "@/lib/tablePagination";

export function useTablePagination<T>(
  sortedFilteredRows: readonly T[],
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
) {
  const [requestedPage, setPage] = useState(1);
  const pagination = getTablePaginationState(
    sortedFilteredRows.length,
    requestedPage,
    pageSize,
  );
  const pageRows = useMemo(
    () => sortedFilteredRows.slice(pagination.startIndex, pagination.endIndex),
    [pagination.endIndex, pagination.startIndex, sortedFilteredRows],
  );

  return {
    ...pagination,
    pageRows,
    setPage,
    resetPage: () => setPage(1),
  };
}

export function TablePagination({
  page,
  pageSize,
  totalCount,
  totalPages,
  showPagination,
  onPageChange,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  showPagination: boolean;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  if (!showPagination) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalCount);

  return (
    <nav
      aria-label="테이블 페이지 이동"
      className="flex flex-col gap-3 border-t border-border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-muted-foreground">
        전체 {totalCount.toLocaleString()}개 · {start.toLocaleString()}–
        {end.toLocaleString()}개 표시
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="이전 페이지"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          이전
        </Button>
        <span className="min-w-16 text-center tabular-nums" aria-live="polite">
          {page} / {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="다음 페이지"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          다음
        </Button>
      </div>
    </nav>
  );
}

export function PaginatedNativeTable({
  children,
}: {
  children: ReactElement<ComponentProps<"table">>;
}) {
  const tableChildren = Children.toArray(children.props.children);
  const bodyIndex = tableChildren.findIndex(
    (child) => isValidElement(child) && child.type === "tbody",
  );
  const body =
    bodyIndex >= 0 &&
    isValidElement<ComponentProps<"tbody">>(tableChildren[bodyIndex])
      ? tableChildren[bodyIndex]
      : null;
  const bodyRows = body ? Children.toArray(body.props.children) : [];
  const signature = bodyRows
    .map((row, index) => (isValidElement(row) && row.key != null ? row.key : index))
    .join("|");
  const [pageState, setPageState] = useState({ page: 1, signature });
  const requestedPage = pageState.signature === signature ? pageState.page : 1;
  const pagination = getTablePaginationState(bodyRows.length, requestedPage);

  const renderedTable =
    pagination.showPagination && body
      ? cloneElement(children, {
          children: tableChildren.map((child, index) =>
            index === bodyIndex
              ? cloneElement(body, {
                  children: bodyRows.slice(pagination.startIndex, pagination.endIndex),
                })
              : child,
          ),
        })
      : children;

  return (
    <>
      {renderedTable}
      <TablePagination
        {...pagination}
        onPageChange={(page) => setPageState({ page, signature })}
      />
    </>
  );
}
