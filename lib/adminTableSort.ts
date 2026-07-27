// 어드민 표 "컬럼 정렬" 공통 계약(SoT) — 순수 함수. React 의존 없음.
// ─────────────────────────────────────────────────────────────────────
// 정렬 규칙은 이미 shared/detailLogSort.ts(주차 상세 액트/라인 표 · 두 레포 byte-identical 미러)가
//   정의해 두었다. 그 파일은 **액트/라인 전용 행 shape** 에 묶여 있고 미러 제약 때문에 컬럼을
//   추가할 수 없어, 다른 표(주차 결과(크루) 등)가 그대로 재사용할 수 없다.
//   → 이 모듈은 **같은 규칙을 행 shape 에 독립적으로** 일반화한 것이다. 규칙을 새로 만들지 않는다:
//
//   · 문자열 → localeCompare(value, "ko-KR", { numeric, sensitivity:"base" }) — 한글 자연 정렬
//   · 숫자   → 수치 비교(문자열 비교 금지: "12" < "2" 방지). 퍼센트/포인트/개수 전부 여기 해당
//   · 날짜   → 원본 ISO/epoch 로 비교(화면 표기 문자열 재파싱 금지)
//   · 불리언 → true 가 asc 에서 앞
//   · null/빈값/"-"/"—" → 방향 무관 **항상 최하단**
//   · tie / 정렬 해제 → 원본(서버) 순서 유지(안정 정렬)
//   · 3단계 순환(asc → desc → 기본 복귀)은 shared/detailLogSort.cycleSort 를 그대로 쓴다.
//
// ⚠ 이 모듈은 **표시 순서만** 다룬다. 값·요약·DTO·snapshot 을 바꾸지 않는다.
// ⚠ value(row) 는 **원본값**을 반환해야 한다(화면 문자열이 아니라). 예: 30 (O) / "30점" (X),
//   "2026-07-20" (O) / "26 - 07 - 20 (월)" (X).

import type { SortDirection } from "@/shared/detailLogSort";

export type { SortDirection };

/** 컬럼 값 타입 — 비교 방식을 정한다. */
export type TableSortType = "text" | "number" | "date" | "boolean";

/** 정렬용 원본값. undefined/null 은 "값 없음"(방향 무관 최하단). */
export type TableSortValue = string | number | boolean | null | undefined;

export type TableColumnSortSpec<T> = {
  type: TableSortType;
  /** 행 → 정렬용 **원본값**(표시 문자열 금지). */
  value: (row: T) => TableSortValue;
};

/** 컬럼 키 → 정렬 계약. 화면의 헤더 컬럼과 1:1. */
export type TableSortColumns<T, K extends string> = Record<K, TableColumnSortSpec<T>>;

export type TableSortState<K extends string> = { key: K; dir: SortDirection } | null;

// ── 값 없음 판정 — 화면에서 "-"/"—"/빈칸으로 보이는 값은 정렬에서도 값 없음으로 취급 ──
function isEmptyValue(v: TableSortValue): boolean {
  if (v == null) return true;
  if (typeof v === "number") return Number.isNaN(v);
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" || t === "-" || t === "—";
  }
  return false;
}

function toNumber(v: TableSortValue): number | null {
  if (isEmptyValue(v)) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function toEpoch(v: TableSortValue): number | null {
  if (isEmptyValue(v)) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

// 숫자 비교 — null 최하단(방향 무관).
function cmpNum(a: number | null, b: number | null, dir: SortDirection): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
}

// 문자 비교 — 빈값 최하단, ko-KR + numeric 자연 정렬.
function cmpText(a: TableSortValue, b: TableSortValue, dir: SortDirection): number {
  const ae = isEmptyValue(a);
  const be = isEmptyValue(b);
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = String(a).localeCompare(String(b), "ko-KR", {
    numeric: true,
    sensitivity: "base",
  });
  return dir === "asc" ? c : -c;
}

/** 단일 값 비교 — 타입별 규칙 + null 최하단(방향 무관). */
export function compareTableValues(
  a: TableSortValue,
  b: TableSortValue,
  type: TableSortType,
  dir: SortDirection,
): number {
  switch (type) {
    case "text":
      return cmpText(a, b, dir);
    case "number":
      return cmpNum(toNumber(a), toNumber(b), dir);
    case "date":
      return cmpNum(toEpoch(a), toEpoch(b), dir);
    case "boolean": {
      // true 가 asc 에서 앞(cmpNum asc 는 작은값이 앞이라 방향을 뒤집는다). null 최하단은 동일.
      const an = a == null ? null : a ? 1 : 0;
      const bn = b == null ? null : b ? 1 : 0;
      return cmpNum(an, bn, dir === "asc" ? "desc" : "asc");
    }
  }
}

/**
 * 표 행 정렬 — 원본 배열은 변형하지 않는다.
 *   · state = null → **원본(서버) 순서 그대로**(기본 정렬 복원). 새 배열도 만들지 않는다.
 *   · 동률은 원본 인덱스로 tie-break(안정 정렬) → 같은 값끼리 순서가 흔들리지 않는다.
 */
export function sortTableRows<T, K extends string>(
  rows: readonly T[],
  state: TableSortState<K>,
  columns: TableSortColumns<T, K>,
): readonly T[] {
  if (!state) return rows;
  const spec = columns[state.key];
  if (!spec) return rows;
  const decorated = rows.map((row, index) => ({ row, index, value: spec.value(row) }));
  decorated.sort((x, y) => {
    const c = compareTableValues(x.value, y.value, spec.type, state.dir);
    return c !== 0 ? c : x.index - y.index;
  });
  return decorated.map((d) => d.row);
}
