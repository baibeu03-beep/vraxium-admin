export const DEFAULT_TABLE_PAGE_SIZE = 20;
export const DEFAULT_TABLE_PAGINATION_THRESHOLD = DEFAULT_TABLE_PAGE_SIZE;

export type TablePaginationState = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  showPagination: boolean;
};

export function getTablePaginationState(
  totalCount: number,
  requestedPage: number,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
  paginationThreshold = DEFAULT_TABLE_PAGINATION_THRESHOLD,
): TablePaginationState {
  const safeTotal = Math.max(0, Math.floor(totalCount) || 0);
  const safePageSize = Math.max(1, Math.floor(pageSize) || DEFAULT_TABLE_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(safeTotal / safePageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), totalPages);
  const startIndex = safeTotal === 0 ? 0 : (page - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, safeTotal);

  return {
    page,
    pageSize: safePageSize,
    totalCount: safeTotal,
    totalPages,
    startIndex,
    endIndex,
    showPagination: safeTotal > paginationThreshold,
  };
}

export function paginateTableRows<T>(
  rows: readonly T[],
  requestedPage: number,
  pageSize = DEFAULT_TABLE_PAGE_SIZE,
): { rows: T[]; pagination: TablePaginationState } {
  const pagination = getTablePaginationState(rows.length, requestedPage, pageSize);
  return {
    rows: rows.slice(pagination.startIndex, pagination.endIndex),
    pagination,
  };
}
