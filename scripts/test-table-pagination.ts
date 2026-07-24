import assert from "node:assert/strict";
import {
  DEFAULT_TABLE_PAGE_SIZE,
  getTablePaginationState,
  paginateTableRows,
} from "@/lib/tablePagination";

const expected = [
  { count: 0, pages: 1, shown: false, pageRows: 0 },
  { count: 1, pages: 1, shown: false, pageRows: 1 },
  { count: 19, pages: 1, shown: false, pageRows: 19 },
  { count: 20, pages: 1, shown: false, pageRows: 20 },
  { count: 21, pages: 2, shown: true, pageRows: 20 },
  { count: 40, pages: 2, shown: true, pageRows: 20 },
  { count: 41, pages: 3, shown: true, pageRows: 20 },
];

for (const test of expected) {
  const rows = Array.from({ length: test.count }, (_, index) => index);
  const result = paginateTableRows(rows, 1);
  assert.equal(result.pagination.pageSize, DEFAULT_TABLE_PAGE_SIZE);
  assert.equal(result.pagination.totalPages, test.pages);
  assert.equal(result.pagination.showPagination, test.shown);
  assert.equal(result.rows.length, test.pageRows);
}

const clamped = getTablePaginationState(19, 2);
assert.equal(clamped.page, 1, "필터 후 빈 2페이지를 1페이지로 보정");

const afterDelete = getTablePaginationState(40, 3);
assert.equal(afterDelete.page, 2, "마지막 페이지 삭제 후 유효한 마지막 페이지로 보정");

const sorted = [5, 1, 4, 2, 3].sort((a, b) => a - b);
assert.deepEqual(paginateTableRows(sorted, 2, 2).rows, [3, 4]);

console.log("PASS table pagination boundaries: 0, 1, 19, 20, 21, 40, 41");
