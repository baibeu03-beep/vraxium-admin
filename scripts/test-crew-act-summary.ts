/**
 * 크루 액트 판정/요약 단위 테스트 — 공통 SoT `shared/crewActSummary`.
 * ─────────────────────────────────────────────────────────────────────
 *   판정 규칙(resolveCrewActResult): Point.C(패널티)>0 = 미스(fail), 그 외 = 성공(success).
 *   요약(buildCrewActSummary): success/fail 은 판정 파생 · 불변식 total===success+fail+pending.
 *   실제 사례: C=[1,1,2,1,12,1,2] → available=7·success=0·fail=7·rate=0·획득화살 20/20.
 *
 *   실행(vraxium):        node_modules/.bin/sucrase-node.cmd scripts/test-crew-act-summary.ts
 *   실행(vraxium-admin):  npx tsx scripts/test-crew-act-summary.ts
 *   (shared/crewActSummary.ts 는 두 repo 미러링·바이트 동일 — 한쪽 실행이 양쪽을 검증.)
 */
import {
  resolveCrewActResult,
  buildCrewActSummary,
  type CrewActSummaryRow,
} from "../shared/crewActSummary";

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else {
    fail++;
    console.log(`❌ ${name}\n     got=${JSON.stringify(got)}\n    want=${JSON.stringify(want)}`);
  }
}

// ── 판정 진리표(요구 명세) ───────────────────────────────────────────────
const truth: Array<[number, number, number, "success" | "fail"]> = [
  [1, 0, 0, "success"], // A만
  [0, 1, 0, "success"], // B만
  [1, 1, 0, "success"], // A+B
  [0, 0, 1, "fail"], //    C만
  [0, 0, 12, "fail"], //   C만(큰 값)
  [1, 0, 1, "fail"], //    정책확인: C 최우선 → 실패
  [0, 1, 1, "fail"], //    정책확인: C 최우선 → 실패
  [0, 0, 0, "success"], // A/B/C 전부 0 = 무포인트 이행자 → 성공(원장 확정 행)
];
for (const [a, b, c, want] of truth) {
  eq(`판정 A${a}/B${b}/C${c}`, resolveCrewActResult({ pointA: a, pointB: b, pointC: c }), want);
}
// 레거시 음수 lightning(-n) 도 magnitude 로 미스 판정.
eq("판정 C=-3(레거시 음수)", resolveCrewActResult({ pointA: 0, pointB: 0, pointC: -3 }), "fail");

// ── 요약 헬퍼 ────────────────────────────────────────────────────────────
const row = (
  pointA: number,
  pointB: number,
  pointC: number,
  source: "regular" | "irregular" = "regular",
  kindKey: CrewActSummaryRow["kindKey"] = "required",
): CrewActSummaryRow => ({ result: "checked", source, kindKey, pointA, pointB, pointC });

// ── 실제 사례: 7행 전부 C>0 ─────────────────────────────────────────────
const realC = [1, 1, 2, 1, 12, 1, 2];
const realRows = realC.map((c) => row(0, 0, c));
const real = buildCrewActSummary(realRows);
eq("실제사례 available(total)", real.total, 7);
eq("실제사례 success", real.success, 0);
eq("실제사례 fail", real.fail, 7);
eq("실제사례 pending", real.pending, 0);
eq("실제사례 rate(0%)", real.rate, 0);
eq("실제사례 획득 화살 earned", real.points.pointC.earned, 20);
eq("실제사례 획득 화살 available", real.points.pointC.available, 20);
eq("실제사례 불변식 total===success+fail+pending", real.total, real.success + real.fail + real.pending);

// ── 혼합 사례: A성공2 · B성공1 · C실패3 · (무포인트 이행1) ─────────────────
const mixed = buildCrewActSummary([
  row(5, 0, 0),
  row(3, 0, 0),
  row(0, 4, 0),
  row(0, 0, 1),
  row(0, 0, 2),
  row(0, 0, 5),
  row(0, 0, 0), // 무포인트 이행 → 성공
]);
eq("혼합 total", mixed.total, 7);
eq("혼합 success(A2+B1+무포인트1)", mixed.success, 4);
eq("혼합 fail(C3)", mixed.fail, 3);
eq("혼합 rate", mixed.rate, Math.round((4 / 7) * 100));

// ── 회귀 방지: result 필드가 checked 여도 C>0 이면 실패로 센다 ──────────────
const regression = buildCrewActSummary([
  { result: "checked", source: "regular", kindKey: "required", pointA: 0, pointB: 0, pointC: 9 },
]);
eq("회귀: result=checked+C>0 → fail 1", regression.fail, 1);
eq("회귀: result=checked+C>0 → success 0", regression.success, 0);

// ── 빈 입력 ──────────────────────────────────────────────────────────────
const empty = buildCrewActSummary([]);
eq("빈 입력 rate 0", empty.rate, 0);
eq("빈 입력 total 0", empty.total, 0);

console.log(`\n═══ crewActSummary 단위 테스트: PASS ${pass} · FAIL ${fail} ═══`);
process.exit(fail > 0 ? 1 : 0);
