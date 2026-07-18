/**
 * 주차 상세 표 정렬 공통 계약(shared/detailLogSort) 단위 테스트 — 순수 로직(서버·DB 불필요).
 *   npx tsx scripts/test-detail-log-sort.ts
 *
 * 고정 픽스처(요구 §11): 액트 기본 / 라인 기본(공식 허브 순서) / 숫자 / 파리티 / null·tie-breaker.
 * 크루 레포에도 동일 파일이 미러링된다(byte-identical). 규칙이 바뀌면 두 테스트 모두 갱신할 것.
 */
import {
  type ActSortRow,
  type LineSortRow,
  sortActRows,
  sortLineRows,
  compareActRows,
  compareLineRows,
  cycleSort,
  hubRank,
} from "@/shared/detailLogSort";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${!ok && detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
}
function eqKeys(rows: { stableKey: string }[], expected: string[]): boolean {
  return JSON.stringify(rows.map((r) => r.stableKey)) === JSON.stringify(expected);
}

// 기본 액트 행 팩토리 — 필요한 필드만 지정.
function act(p: Partial<ActSortRow> & { stableKey: string }): ActSortRow {
  return {
    result: "성공",
    name: "액트",
    occurredAt: null,
    hubToken: null,
    line: "",
    duration: 0,
    pointA: 0,
    pointB: 0,
    pointC: 0,
    source: "정규",
    kind: "필수",
    ...p,
  };
}
function line(p: Partial<LineSortRow> & { stableKey: string }): LineSortRow {
  return {
    result: "강화 성공",
    name: "라인",
    hubToken: null,
    kind: "일반",
    duration: 0,
    rating: null,
    pointA: 0,
    pointB: 0,
    pointC: 0,
    growthRequirement: "자율",
    clubOpen: true,
    ...p,
  };
}

// ── 1. 액트 기본 정렬 ──────────────────────────────────────────────────
// 픽스처: 10:00/b, 09:00/c, 10:00/a, null/d  → 기대: c(09:00), a(10:00), b(10:00), d(null 최하단)
{
  const T = "2026-07-15T";
  const rows: ActSortRow[] = [
    act({ stableKey: "b", occurredAt: `${T}10:00:00Z` }),
    act({ stableKey: "c", occurredAt: `${T}09:00:00Z` }),
    act({ stableKey: "a", occurredAt: `${T}10:00:00Z` }),
    act({ stableKey: "d", occurredAt: null }),
  ];
  const sorted = sortActRows(rows, null, (r) => r);
  check("액트 기본: 발생시점 ASC → stableKey ASC → null 최하단", eqKeys(sorted, ["c", "a", "b", "d"]), sorted.map((r) => r.stableKey));

  // 원본 배열 비변형 확인.
  check("액트 정렬은 원본 배열을 변형하지 않음", rows[0].stableKey === "b");
}

// ── 2. 라인 기본 정렬(공식 허브 순서) ────────────────────────────────────
// 실제 공식 허브 순서 = club → info → experience → competency → career.
// 픽스처 허브: 역량/클럽/경험/정보/null → 기대: 클럽, 정보, 경험, 역량, null(최하단).
{
  const rows: LineSortRow[] = [
    line({ stableKey: "comp", hubToken: "competency" }),
    line({ stableKey: "club", hubToken: "club" }),
    line({ stableKey: "exp", hubToken: "experience" }),
    line({ stableKey: "info", hubToken: "information" }), // partType 별칭
    line({ stableKey: "none", hubToken: null }),
  ];
  const sorted = sortLineRows(rows, null, (r) => r);
  check(
    "라인 기본: 공식 허브 순서 ASC → null 최하단",
    eqKeys(sorted, ["club", "info", "exp", "comp", "none"]),
    sorted.map((r) => r.stableKey),
  );
}

// 같은 허브 내 tie-breaker = stableKey ASC(라인엔 발생시점 필드 없음).
{
  const rows: LineSortRow[] = [
    line({ stableKey: "experience:2", hubToken: "practical_experience" }),
    line({ stableKey: "experience:0", hubToken: "experience" }),
    line({ stableKey: "experience:1", hubToken: "실무 경험" }), // 한글 라벨 별칭
  ];
  const sorted = sortLineRows(rows, null, (r) => r);
  check(
    "라인 기본: 같은 허브(별칭 혼재)면 stableKey ASC",
    eqKeys(sorted, ["experience:0", "experience:1", "experience:2"]),
    sorted.map((r) => r.stableKey),
  );
}

// ── 3. 숫자 정렬(문자열 정렬 아님) ──────────────────────────────────────
// [2, 10, 100] → 2, 10, 100 (문자열이면 10,100,2 가 됨).
{
  const rows: LineSortRow[] = [
    line({ stableKey: "x100", duration: 100 }),
    line({ stableKey: "x2", duration: 2 }),
    line({ stableKey: "x10", duration: 10 }),
  ];
  const asc = sortLineRows(rows, { key: "duration", dir: "asc" }, (r) => r);
  check("숫자 ASC: 2,10,100 (문자열 정렬 아님)", JSON.stringify(asc.map((r) => r.duration)) === JSON.stringify([2, 10, 100]), asc.map((r) => r.duration));
  const desc = sortLineRows(rows, { key: "duration", dir: "desc" }, (r) => r);
  check("숫자 DESC: 100,10,2", JSON.stringify(desc.map((r) => r.duration)) === JSON.stringify([100, 10, 2]), desc.map((r) => r.duration));
}

// 액트 포인트 숫자 정렬 + null 최하단.
{
  const rows: ActSortRow[] = [
    act({ stableKey: "p12", pointA: 12 }),
    act({ stableKey: "p2", pointA: 2 }),
    act({ stableKey: "pnull", pointA: null }),
    act({ stableKey: "p100", pointA: 100 }),
  ];
  const asc = sortActRows(rows, { key: "pointA", dir: "asc" }, (r) => r);
  check("포인트 ASC: 2,12,100,null(최하단)", eqKeys(asc, ["p2", "p12", "p100", "pnull"]), asc.map((r) => r.stableKey));
  const desc = sortActRows(rows, { key: "pointA", dir: "desc" }, (r) => r);
  check("포인트 DESC: 100,12,2,null(여전히 최하단)", eqKeys(desc, ["p100", "p12", "p2", "pnull"]), desc.map((r) => r.stableKey));
}

// ── 4. 문자열(한글) 정렬 + 빈값 최하단 ─────────────────────────────────
{
  const rows: ActSortRow[] = [
    act({ stableKey: "n2", name: "나액트" }),
    act({ stableKey: "n1", name: "가액트" }),
    act({ stableKey: "nEmpty", name: "-" }),
    act({ stableKey: "n3", name: "다액트" }),
  ];
  const asc = sortActRows(rows, { key: "name", dir: "asc" }, (r) => r);
  check("문자 ASC: 가,나,다,빈값(최하단)", eqKeys(asc, ["n1", "n2", "n3", "nEmpty"]), asc.map((r) => r.stableKey));
  const desc = sortActRows(rows, { key: "name", dir: "desc" }, (r) => r);
  check("문자 DESC: 다,나,가,빈값(여전히 최하단)", eqKeys(desc, ["n3", "n2", "n1", "nEmpty"]), desc.map((r) => r.stableKey));
}

// ── 5. 날짜: 화면 문자열이 아니라 원본 timestamp epoch 로 비교 ────────────
{
  // 표시 문자열이면 "2026.01.02" < "2026.1.10" 같은 오정렬이 나지만, epoch 로 비교하면 정상.
  const rows: ActSortRow[] = [
    act({ stableKey: "late", occurredAt: "2026-07-15T23:30:00Z" }),
    act({ stableKey: "early", occurredAt: "2026-07-15T08:05:00Z" }),
    act({ stableKey: "mid", occurredAt: "2026-07-15T12:00:00Z" }),
  ];
  const asc = sortActRows(rows, { key: "occurredAt", dir: "asc" }, (r) => r);
  check("날짜 ASC(epoch): early,mid,late", eqKeys(asc, ["early", "mid", "late"]), asc.map((r) => r.stableKey));
}

// ── 6. 헤더 3단계 순환(없음 → asc → desc → 없음) ───────────────────────
{
  let s: { key: "name"; dir: "asc" | "desc" } | null = null;
  s = cycleSort(s, "name");
  check("cycle 1: asc", s?.dir === "asc");
  s = cycleSort(s, "name");
  check("cycle 2: desc", s?.dir === "desc");
  s = cycleSort(s, "name");
  check("cycle 3: 기본 복귀(null)", s === null);
  // 다른 컬럼 클릭 → 즉시 asc
  let s2: { key: "name" | "duration"; dir: "asc" | "desc" } | null = { key: "name", dir: "desc" };
  s2 = cycleSort(s2, "duration");
  check("다른 컬럼 클릭 → asc", s2?.key === "duration" && s2?.dir === "asc");
}

// ── 7. 파리티: 동일 fixture → 동일 stableKey[] (comparator 결정성) ─────────
{
  const fixture: ActSortRow[] = [
    act({ stableKey: "k3", occurredAt: "2026-07-15T10:00:00Z", pointA: 5 }),
    act({ stableKey: "k1", occurredAt: "2026-07-15T09:00:00Z", pointA: 9 }),
    act({ stableKey: "k2", occurredAt: "2026-07-15T10:00:00Z", pointA: 1 }),
  ];
  // "어드민 경로"와 "크루 경로"는 동일 shared 함수를 쓴다 → 동일 순서 보장.
  const adminOrder = sortActRows(fixture, { key: "occurredAt", dir: "asc" }, (r) => r).map((r) => r.stableKey);
  const crewOrder = [...fixture].sort((a, b) => compareActRows(a, b, "occurredAt", "asc")).map((r) => r.stableKey);
  check("파리티: sortActRows == compareActRows 직접정렬", JSON.stringify(adminOrder) === JSON.stringify(crewOrder), { adminOrder, crewOrder });

  const lineFix: LineSortRow[] = [
    line({ stableKey: "l2", hubToken: "career" }),
    line({ stableKey: "l1", hubToken: "info" }),
    line({ stableKey: "l3", hubToken: "experience" }),
  ];
  const a = sortLineRows(lineFix, null, (r) => r).map((r) => r.stableKey);
  const b = [...lineFix].sort((x, y) => compareLineRows(x, y, "hub", "asc")).map((r) => r.stableKey);
  check("파리티(라인 기본 == hub asc)", JSON.stringify(a) === JSON.stringify(b), { a, b });
}

// ── 8. hubRank 별칭 매핑 ────────────────────────────────────────────────
{
  check("hubRank: club<info<experience<competency<career", hubRank("club") < hubRank("info") && hubRank("info") < hubRank("experience") && hubRank("experience") < hubRank("competency") && hubRank("competency") < hubRank("career"));
  check("hubRank: 별칭 동일 랭크", hubRank("info") === hubRank("information") && hubRank("information") === hubRank("practical_info") && hubRank("practical_info") === hubRank("실무 정보"));
  check("hubRank: 미상/빈값 → Infinity", hubRank(null) === Number.POSITIVE_INFINITY && hubRank("-") === Number.POSITIVE_INFINITY && hubRank("zzz") === Number.POSITIVE_INFINITY);
}

console.log(`\n═══ 결과: PASS ${passed} · FAIL ${failed} ═══`);
process.exit(failed > 0 ? 1 : 0);
