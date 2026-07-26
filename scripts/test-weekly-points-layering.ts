/**
 * user_weekly_points 포인트 계층 분리 단위 테스트 — 순수 로직(서버·DB 불필요).
 *   npx tsx scripts/test-weekly-points-layering.ts
 *
 * 계약: points = legacy + Σ활성 award · award 를 적립/수정/취소/삭제해도 legacy 는 불변 ·
 *       재계산은 가산이 아니라 재구성이라 반복 실행해도 값이 변하지 않는다.
 */
import {
  ZERO_TRIPLE,
  composeWeeklyPointTotals,
  isLegacyFreeWeek,
  readBaselineFromRow,
  sumAwardTriple,
  type PointTriple,
} from "@/lib/userWeeklyPointsBaseline";
import { resolvePointAwardRows } from "@/lib/pointResolver";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "✅" : "❌"} ${name}${!ok && detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
}
const eq = (a: PointTriple, b: PointTriple) =>
  a.points === b.points && a.advantages === b.advantages && a.penalty === b.penalty;
const T = (points: number, advantages: number, penalty: number): PointTriple => ({ points, advantages, penalty });

type Award = { point_check: number; point_advantage: number; point_penalty: number; cancelled_at?: string | null };
const active = (rows: Award[]) => rows.filter((r) => !r.cancelled_at);

/** 프로덕션 재계산 경로의 순수 모델 — recomputeWeeklyPoints 의 3·4단계와 동일 산식. */
function recompute(baseline: PointTriple, allAwards: Award[]): PointTriple {
  return composeWeeklyPointTotals(baseline, sumAwardTriple(active(allAwards)));
}

console.log("── ① 기존 PMS 포인트만 있는 주차 ─────────────────────────────");
{
  // 최윤하 2024-07-01 실사례 형상: PMS 48/2/4
  const legacy = T(48, 2, 4);
  const noAward: Award[] = [];
  check("award 적립 전 기존값 보존", eq(recompute(legacy, noAward), T(48, 2, 4)), recompute(legacy, noAward));

  // 라인 결과 award 1건(0/1/0) 적립
  const awarded: Award[] = [{ point_check: 0, point_advantage: 1, point_penalty: 0 }];
  check("신규 award 적립 후 = 기존값 + award", eq(recompute(legacy, awarded), T(48, 3, 4)), recompute(legacy, awarded));

  // 취소(soft cancel)
  const cancelled: Award[] = [{ point_check: 0, point_advantage: 1, point_penalty: 0, cancelled_at: "2026-07-16T08:35:36Z" }];
  check("award 취소 후 정확히 기존값 복귀", eq(recompute(legacy, cancelled), T(48, 2, 4)), recompute(legacy, cancelled));

  // 삭제(hard delete = 행 자체 사라짐)
  check("award 삭제 후 정확히 기존값 복귀", eq(recompute(legacy, []), T(48, 2, 4)), recompute(legacy, []));

  // 회귀 가드: 구버전(=활성 award 합으로 덮어쓰기)이었다면 0/0/0 이 됐어야 한다.
  const oldBehaviour = sumAwardTriple(active(cancelled));
  check("구버전 산식이었다면 0 이 됨(회귀 가드)", eq(oldBehaviour, T(0, 0, 0)), oldBehaviour);
}

console.log("\n── ② PMS 와 award 가 모두 있는 주차 ──────────────────────────");
{
  const legacy = T(20, 5, 3);
  const awards: Award[] = [
    { point_check: 7, point_advantage: 2, point_penalty: 0 },
    { point_check: 0, point_advantage: 0, point_penalty: -4 }, // 원장이 음수로 들어와도
    { point_check: 3, point_advantage: 1, point_penalty: 2 },  // 양수로 들어와도
    { point_check: 9, point_advantage: 9, point_penalty: 9, cancelled_at: "x" }, // 취소분 제외
  ];
  const total = recompute(legacy, awards);
  check("A 합산", total.points === 20 + 10, total);
  check("raw advantage 합산", total.advantages === 5 + 3, total);
  check("penalty 합산(부호 무관 크기)", total.penalty === 3 + 6, total);

  const resolved = resolvePointAwardRows([
    { point_check: total.points, point_advantage: total.advantages, point_penalty: total.penalty },
  ]);
  check("B = raw advantage − penalty magnitude", resolved.pointB === total.advantages - total.penalty, resolved);
  check("C 는 항상 양수", resolved.pointC === 9 && resolved.pointC > 0, resolved);
  check("A 는 resolver 와 동일", resolved.pointA === 30, resolved);
}

console.log("\n── ③ penalty 부호 정규화 ─────────────────────────────────────");
{
  check("음수 penalty → 양수 크기", sumAwardTriple([{ point_penalty: -5 }]).penalty === 5);
  check("양수 penalty → 그대로", sumAwardTriple([{ point_penalty: 5 }]).penalty === 5);
  check("혼합 penalty 는 크기 합", sumAwardTriple([{ point_penalty: -5 }, { point_penalty: 3 }]).penalty === 8);
  const c = resolvePointAwardRows([{ point_penalty: 8 }]);
  check("resolver C 양수 유지", c.pointC === 8 && c.pointB === -8, c);
}

console.log("\n── ④ award 만 있는 신규 주차(기존 동작 유지) ─────────────────");
{
  const legacy = ZERO_TRIPLE;
  const awards: Award[] = [{ point_check: 5, point_advantage: 2, point_penalty: 0 }];
  check("신규 주차 적립 = award 그대로", eq(recompute(legacy, awards), T(5, 2, 0)), recompute(legacy, awards));
  const cancelled: Award[] = [{ ...awards[0], cancelled_at: "x" }];
  check("신규 주차 취소 → 0 복귀", eq(recompute(legacy, cancelled), T(0, 0, 0)), recompute(legacy, cancelled));
  check("신규 주차 삭제 → 0 복귀", eq(recompute(legacy, []), T(0, 0, 0)), recompute(legacy, []));
}

console.log("\n── ⑤ 반복 실행 멱등성 ───────────────────────────────────────");
{
  const legacy = T(48, 2, 4);
  const awards: Award[] = [{ point_check: 3, point_advantage: 1, point_penalty: 2 }];
  let cur = recompute(legacy, awards);
  const first = { ...cur };
  for (let i = 0; i < 25; i++) cur = recompute(legacy, awards); // 재계산 반복
  check("25회 재계산해도 값 불변(증가·감소 없음)", eq(cur, first) && eq(cur, T(51, 3, 6)), { first, cur });

  // 취소 ↔ 재활성 왕복도 값이 튀지 않는다.
  const cycleA = recompute(legacy, [{ ...awards[0], cancelled_at: "x" }]);
  const cycleB = recompute(legacy, awards);
  const cycleC = recompute(legacy, [{ ...awards[0], cancelled_at: "x" }]);
  check("취소→재활성→취소 왕복 안정", eq(cycleA, T(48, 2, 4)) && eq(cycleB, T(51, 3, 6)) && eq(cycleC, T(48, 2, 4)), { cycleA, cycleB, cycleC });
}

console.log("\n── ⑥ 기준층 읽기(readBaselineFromRow) ────────────────────────");
{
  check("행 없음 → null", readBaselineFromRow(null) === null);
  check("legacy 전부 NULL → null(미분리)", readBaselineFromRow({ legacy_points: null, legacy_advantages: null, legacy_penalty: null }) === null);
  const b = readBaselineFromRow({ legacy_points: 48, legacy_advantages: 2, legacy_penalty: 4 });
  check("legacy 채워짐 → 그 값", b !== null && eq(b, T(48, 2, 4)), b);
  const partial = readBaselineFromRow({ legacy_points: 7, legacy_advantages: null, legacy_penalty: null });
  check("부분 NULL → 0 으로 보정", partial !== null && eq(partial, T(7, 0, 0)), partial);
  const zero = readBaselineFromRow({ legacy_points: 0, legacy_advantages: 0, legacy_penalty: 0 });
  check("legacy 0 은 '미분리' 가 아니라 값 0", zero !== null && eq(zero, ZERO_TRIPLE), zero);
}

console.log("\n── ⑦ 컬럼 미적용 폴백 게이트(isLegacyFreeWeek) ───────────────");
{
  const FROM = "2026-06-29";
  check("신정책 era 주차 → 덮어쓰기 안전", isLegacyFreeWeek("2026-06-29", FROM) && isLegacyFreeWeek("2026-07-20", FROM));
  check("레거시 era 주차 → 안전하지 않음(건너뜀)", !isLegacyFreeWeek("2026-06-22", FROM) && !isLegacyFreeWeek("2024-07-01", FROM));
  check("ledger 최종 귀속 주차(2026-06-22) 는 레거시 취급", !isLegacyFreeWeek("2026-06-22", FROM));
  check("null/undefined → 안전하지 않음", !isLegacyFreeWeek(null, FROM) && !isLegacyFreeWeek(undefined, FROM));
}

console.log("\n── ⑧ 레거시 음수 A 보존(1900 sentinel 형상) ──────────────────");
{
  // 실측: 1900-01-01 sentinel 128행이 음수 A 를 가진다. 임의 clamp 금지 — 그대로 보존돼야 한다.
  const legacy = T(-82, 10, 0);
  check("음수 legacy A 보존", recompute(legacy, []).points === -82);
  check("음수 legacy + award", recompute(legacy, [{ point_check: 5, point_advantage: 0, point_penalty: 0 }]).points === -77);
}

console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAIL"} — passed ${passed} / failed ${failed}`);
process.exit(failed === 0 ? 0 : 1);
