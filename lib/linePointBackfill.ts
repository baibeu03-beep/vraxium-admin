/**
 * 과거 라인 Point.A / Point.B 무작위(결정론적) 배정 — 순수 로직.  [Phase 3 아티팩트]
 *
 * 정책(2026-07-11 확정):
 *  - 배정 비율: Point.A만 30% / Point.B만 30% / A+B 40%
 *  - 수량 범위: 액트와 동일 0~20 (배정되는 쪽은 1~20, 미배정 쪽은 0)
 *  - 동일 line 은 재실행해도 항상 동일 결과 → seed = 라인 식별자(Math.random 금지)
 *  - 테스트 데이터 준비 목적: 재현성·안전성 우선
 *
 * 이 파일은 "값 계산"만 담당한다. DB 쓰기·기존값 skip·dry-run·rollback 은
 * scripts/backfill-line-points.ts 가 담당한다(설정값만, ledger 무접촉).
 */

// xmur3: 문자열 → 32bit seed (deterministic).
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32: 32bit seed → [0,1) PRNG (deterministic).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type LinePointBucket = "a_only" | "b_only" | "both";

export type LinePointAssignment = {
  bucket: LinePointBucket;
  pointA: number; // 0~20
  pointB: number; // 0~20
};

// 배정 비율(누적 임계). A만 0.30 / B만 0.30 / 둘다 0.40.
const A_ONLY_MAX = 0.3;
const B_ONLY_MAX = 0.6; // 0.3 + 0.3

// 배정 수량: 1~20 (배정되는 포인트는 최소 1 — 0 배정은 의미가 없어 제외). 미배정 쪽은 0.
function draw1to20(rng: () => number): number {
  return 1 + Math.floor(rng() * 20); // floor([0,1)*20)=0..19 → 1..20
}

/**
 * 라인 식별자로부터 결정론적으로 Point.A / Point.B 를 배정한다.
 * 같은 lineId + 같은 salt → 항상 같은 결과.
 * @param salt 산식 버전/재현 컨텍스트 분리용(기본 고정). 바꾸면 전체 배정이 달라지므로 신중히.
 */
export function assignLinePoints(lineId: string, salt = "line-point-v1"): LinePointAssignment {
  const seed = xmur3(`${salt}:${lineId}`)();
  const rng = mulberry32(seed);
  const roll = rng(); // 버킷 결정
  let bucket: LinePointBucket;
  if (roll < A_ONLY_MAX) bucket = "a_only";
  else if (roll < B_ONLY_MAX) bucket = "b_only";
  else bucket = "both";

  // 버킷 결정 후 동일 rng 스트림에서 수량을 뽑는다(결정론 유지).
  const amtA = draw1to20(rng);
  const amtB = draw1to20(rng);
  return {
    bucket,
    pointA: bucket === "a_only" || bucket === "both" ? amtA : 0,
    pointB: bucket === "b_only" || bucket === "both" ? amtB : 0,
  };
}

export const LINE_POINT_RATIO = { aOnly: 0.3, bOnly: 0.3, both: 0.4 } as const;
