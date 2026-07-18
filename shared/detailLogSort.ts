// 주차 상세 "액트 체크 내역" · "라인 강화 내역" 표 정렬 공통 계약(SoT) — 순수 함수.
// ─────────────────────────────────────────────────────────────────────
// ⚠ 이 파일은 두 repo 에 **미러링**된다(shared/crewActSummary.ts 와 동일 규약):
//     vraxium-admin/shared/detailLogSort.ts  ==  vraxium/shared/detailLogSort.ts
//   반드시 **byte-identical** 유지 — parity 스크립트 검증(scripts/verify-detail-log-sort-parity).
//   한쪽만 고치면 어드민 표와 크루 /cluster-4-card Detail Log 의 정렬이 갈라진다.
//
// 목적: 어드민(회원 주차 상세)·크루(Detail Log) 두 앱이 서로 다른 comparator 를 각자 구현하지
//   않도록, **정렬 규칙(문자/숫자/날짜/허브순서/null/tie-breaker/기본정렬)** 을 한 곳에서 정의한다.
//   - 이 모듈은 **표시 순서만** 다룬다. 성공/실패 판정·포인트·요약값·snapshot 원본을 바꾸지 않는다.
//   - 두 앱의 row DTO 는 다르므로(어드민 CrewWeekLineDetailRow vs 크루 CrewWeekLineEnhancementRowDto),
//     각 앱이 자신의 행을 아래 정규화 shape(ActSortRow/LineSortRow)로 매핑해 넘긴다.
//     동일한 정규화 입력이면 두 앱에서 **동일 순서**가 나온다(파리티 보장은 comparator 단위).
//
// 정책:
//   · 문자열   → localeCompare(value, "ko-KR", { numeric, sensitivity:"base" }) — 한글 표시명 자연 정렬
//   · 숫자     → 수치 비교(문자열 비교 금지: "12" < "2" 방지)
//   · 날짜     → 원본 ISO timestamp 를 epoch 로 파싱해 비교(화면 문자열 재파싱 금지)
//   · 허브     → 공식 허브 순서(HUB_RANK) 우선(localeCompare 아님)
//   · null/빈값/"-"/"—"/알 수 없음 → 방향 무관 **항상 최하단**
//   · tie-breaker → stableKey ASC(방향 무관·결정적)
//   · 기본 정렬 → 액트: 발생 시점 ASC → stableKey ASC / 라인: 허브 공식순서 ASC → stableKey ASC

export type SortDirection = "asc" | "desc";

// 액트 체크 내역 정렬 키 — 실제 렌더 컬럼과 1:1.
export type ActSortKey =
  | "result" // 결과
  | "name" // 액트명
  | "occurredAt" // 발생 시점
  | "hub" // 소속 허브
  | "line" // 소속 라인
  | "duration" // 소요 시간
  | "pointA" // 투구/별 (Point.A)
  | "pointB" // 방패 (Point.B)
  | "pointC" // 화살/번개 (Point.C)
  | "source" // 구분(정규/변동)
  | "kind"; // 종류(필수/선별 등)

// 라인 강화 내역 정렬 키 — 두 앱 컬럼의 합집합(각 앱은 자신이 렌더하는 컬럼만 배선).
export type LineSortKey =
  | "result" // 결과/강화 결과
  | "name" // 라인명
  | "hub" // 소속 허브(크루 평면 표 전용 — 어드민은 허브 그룹으로 분리)
  | "kind" // 유형/종류
  | "duration" // 소요 시간
  | "rating" // 평점
  | "pointA" // 획득 A
  | "pointB" // 획득 B
  | "pointC" // 획득 C(크루 전용 — 어드민 표엔 없음)
  | "growthRequirement" // 주차 성장 조건(크루 전용)
  | "clubOpen"; // 클럽 오픈(어드민 전용)

export type ActSortState = { key: ActSortKey; dir: SortDirection } | null;
export type LineSortState = { key: LineSortKey; dir: SortDirection } | null;

// 정규화된 액트 정렬 행 — 각 앱이 자신의 row 를 이 shape 으로 매핑한다.
//   숫자/날짜는 **원본값**을(문자열 아님), 결과/구분/종류는 화면 표시 라벨을 넣는다.
export interface ActSortRow {
  stableKey: string; // 결정적 tie-breaker(어드민=awardId, 크루=index 파생)
  result: string; // 결과 표시 라벨
  name: string; // 액트명
  occurredAt: string | null; // 발생 시점(원본 ISO). 없으면 null → 최하단
  hubToken: string | null; // 허브 코드/라벨(HUB_RANK 로 공식순서 랭크)
  line: string; // 소속 라인명("" 이면 최하단)
  duration: number | null; // 소요 시간(분)
  pointA: number | null;
  pointB: number | null;
  pointC: number | null;
  source: string; // 구분 라벨(정규/변동)
  kind: string; // 종류 라벨(필수/선별/-)
}

// 정규화된 라인 정렬 행.
export interface LineSortRow {
  stableKey: string;
  result: string; // 강화 결과 라벨
  name: string; // 라인명
  hubToken: string | null; // 허브 코드/라벨(공식순서 랭크)
  kind: string; // 유형/종류 라벨
  duration: number | null; // 소요 시간(분)
  rating: number | null; // 평점(0~10)
  pointA: number | null; // 획득 A
  pointB: number | null; // 획득 B
  pointC: number | null; // 획득 C
  growthRequirement: string; // 주차 성장 조건 라벨
  clubOpen: boolean | null; // 클럽 오픈 여부
}

// ── 공식 허브 순서 SoT ────────────────────────────────────────────────
//   어드민 PROCESS_HUBS(club→info→experience→competency→career) 와 동일 순서.
//   두 앱이 허브를 서로 다르게 표현(원시 enum / partType / practical_* / 한글 라벨)하므로
//   모든 별칭을 같은 랭크로 매핑한다. 알 수 없는 값/미설정 → +Infinity(최하단).
const HUB_RANK: Record<string, number> = {
  // club
  club: 0,
  "클럽 총괄": 0,
  "클럽": 0,
  // 실무 정보
  info: 1,
  information: 1,
  practical_info: 1,
  "실무 정보": 1,
  // 실무 경험
  experience: 2,
  practical_experience: 2,
  "실무 경험": 2,
  // 실무 역량
  competency: 3,
  practical_competency: 3,
  "실무 역량": 3,
  // 실무 경력
  career: 4,
  practical_career: 4,
  "실무 경력": 4,
};

// 허브 토큰(원시 enum / partType / practical_* / 한글 라벨) → 공식순서 랭크. 미지정/미상 → +Infinity.
export function hubRank(token: string | null | undefined): number {
  if (token == null) return Number.POSITIVE_INFINITY;
  const t = token.trim();
  if (t === "" || t === "-" || t === "—") return Number.POSITIVE_INFINITY;
  const r = HUB_RANK[t];
  return r == null ? Number.POSITIVE_INFINITY : r;
}

// ── 비교 원시(primitive) — 전부 방향 무관 null/빈값 최하단 ────────────────
function isEmptyText(v: string | null | undefined): boolean {
  if (v == null) return true;
  const t = v.trim();
  return t === "" || t === "-" || t === "—" || t === "알 수 없음";
}

// 문자 비교 — 빈값 최하단, ko-KR + numeric 자연 정렬.
function cmpText(a: string | null | undefined, b: string | null | undefined, dir: SortDirection): number {
  const ae = isEmptyText(a);
  const be = isEmptyText(b);
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = (a as string).localeCompare(b as string, "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

// 숫자 비교 — null 최하단(방향 무관).
function cmpNum(a: number | null | undefined, b: number | null | undefined, dir: SortDirection): number {
  const an = a == null || Number.isNaN(a) ? null : a;
  const bn = b == null || Number.isNaN(b) ? null : b;
  if (an == null && bn == null) return 0;
  if (an == null) return 1;
  if (bn == null) return -1;
  return dir === "asc" ? an - bn : bn - an;
}

// 원본 ISO timestamp → epoch(ms). null/빈값/파싱불가 → null(최하단).
function toEpoch(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// 날짜 비교 — 화면 문자열이 아니라 원본 timestamp epoch 로 비교. null/무효 최하단.
function cmpDate(a: string | null | undefined, b: string | null | undefined, dir: SortDirection): number {
  return cmpNum(toEpoch(a), toEpoch(b), dir);
}

// 허브 비교 — 공식순서 랭크(HUB_RANK). 미상/미설정은 방향 무관 최하단.
function cmpHub(a: string | null | undefined, b: string | null | undefined, dir: SortDirection): number {
  const ar = hubRank(a);
  const br = hubRank(b);
  const an = Number.isFinite(ar) ? ar : null;
  const bn = Number.isFinite(br) ? br : null;
  return cmpNum(an, bn, dir);
}

// 불리언 비교 — true 를 먼저(asc: true<false). null 최하단.
function cmpBool(a: boolean | null | undefined, b: boolean | null | undefined, dir: SortDirection): number {
  const an = a == null ? null : a ? 1 : 0;
  const bn = b == null ? null : b ? 1 : 0;
  // true(1) 가 asc 에서 앞. cmpNum asc 는 작은값이 앞이므로 부호를 뒤집는다.
  return cmpNum(an, bn, dir === "asc" ? "desc" : "asc");
}

// stableKey ASC — 방향 무관 결정적 tie-breaker.
function cmpStableKey(a: string, b: string): number {
  return a.localeCompare(b, "ko-KR", { numeric: true, sensitivity: "base" });
}

// ── 컬럼 comparator ───────────────────────────────────────────────────
export function compareActRows(a: ActSortRow, b: ActSortRow, key: ActSortKey, dir: SortDirection): number {
  let c = 0;
  switch (key) {
    case "result":
      c = cmpText(a.result, b.result, dir);
      break;
    case "name":
      c = cmpText(a.name, b.name, dir);
      break;
    case "occurredAt":
      c = cmpDate(a.occurredAt, b.occurredAt, dir);
      break;
    case "hub":
      c = cmpHub(a.hubToken, b.hubToken, dir);
      break;
    case "line":
      c = cmpText(a.line, b.line, dir);
      break;
    case "duration":
      c = cmpNum(a.duration, b.duration, dir);
      break;
    case "pointA":
      c = cmpNum(a.pointA, b.pointA, dir);
      break;
    case "pointB":
      c = cmpNum(a.pointB, b.pointB, dir);
      break;
    case "pointC":
      c = cmpNum(a.pointC, b.pointC, dir);
      break;
    case "source":
      c = cmpText(a.source, b.source, dir);
      break;
    case "kind":
      c = cmpText(a.kind, b.kind, dir);
      break;
  }
  if (c !== 0) return c;
  return cmpStableKey(a.stableKey, b.stableKey);
}

export function compareLineRows(a: LineSortRow, b: LineSortRow, key: LineSortKey, dir: SortDirection): number {
  let c = 0;
  switch (key) {
    case "result":
      c = cmpText(a.result, b.result, dir);
      break;
    case "name":
      c = cmpText(a.name, b.name, dir);
      break;
    case "hub":
      c = cmpHub(a.hubToken, b.hubToken, dir);
      break;
    case "kind":
      c = cmpText(a.kind, b.kind, dir);
      break;
    case "duration":
      c = cmpNum(a.duration, b.duration, dir);
      break;
    case "rating":
      c = cmpNum(a.rating, b.rating, dir);
      break;
    case "pointA":
      c = cmpNum(a.pointA, b.pointA, dir);
      break;
    case "pointB":
      c = cmpNum(a.pointB, b.pointB, dir);
      break;
    case "pointC":
      c = cmpNum(a.pointC, b.pointC, dir);
      break;
    case "growthRequirement":
      c = cmpText(a.growthRequirement, b.growthRequirement, dir);
      break;
    case "clubOpen":
      c = cmpBool(a.clubOpen, b.clubOpen, dir);
      break;
  }
  if (c !== 0) return c;
  return cmpStableKey(a.stableKey, b.stableKey);
}

// ── 기본 정렬 comparator ──────────────────────────────────────────────
// 액트 기본: 발생 시점 ASC(null 최하단) → stableKey ASC.
export function compareActDefault(a: ActSortRow, b: ActSortRow): number {
  const c = cmpDate(a.occurredAt, b.occurredAt, "asc");
  if (c !== 0) return c;
  return cmpStableKey(a.stableKey, b.stableKey);
}

// 라인 기본: 소속 허브 공식순서 ASC(미상 최하단) → stableKey ASC.
//   라인 행엔 발생 시점 필드가 없어 2차 키(발생 시점)는 생략된다(허브 → stableKey).
export function compareLineDefault(a: LineSortRow, b: LineSortRow): number {
  const c = cmpHub(a.hubToken, b.hubToken, "asc");
  if (c !== 0) return c;
  return cmpStableKey(a.stableKey, b.stableKey);
}

// ── 정렬 실행(안정 정렬 — 원본 인덱스로 최종 tie-break) ─────────────────
//   원본 배열은 변형하지 않고(복사) 새 배열을 반환한다.
export function sortActRows<T>(rows: readonly T[], state: ActSortState, toSortRow: (row: T) => ActSortRow): T[] {
  const decorated = rows.map((row, index) => ({ row, index, key: toSortRow(row) }));
  decorated.sort((x, y) => {
    const c = state ? compareActRows(x.key, y.key, state.key, state.dir) : compareActDefault(x.key, y.key);
    return c !== 0 ? c : x.index - y.index;
  });
  return decorated.map((d) => d.row);
}

export function sortLineRows<T>(rows: readonly T[], state: LineSortState, toSortRow: (row: T) => LineSortRow): T[] {
  const decorated = rows.map((row, index) => ({ row, index, key: toSortRow(row) }));
  decorated.sort((x, y) => {
    const c = state ? compareLineRows(x.key, y.key, state.key, state.dir) : compareLineDefault(x.key, y.key);
    return c !== 0 ? c : x.index - y.index;
  });
  return decorated.map((d) => d.row);
}

// ── 헤더 클릭 3단계 순환: 없음 → asc → desc → 없음(기본 복귀) ──────────
export function cycleSort<K extends string>(
  current: { key: K; dir: SortDirection } | null,
  key: K,
): { key: K; dir: SortDirection } | null {
  if (!current || current.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return null; // desc → 기본 정렬로 복귀
}

// aria-sort 속성값 — 접근성(현재 컬럼의 정렬 상태).
export function ariaSortValue(dir: SortDirection | null): "ascending" | "descending" | "none" {
  return dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
}
