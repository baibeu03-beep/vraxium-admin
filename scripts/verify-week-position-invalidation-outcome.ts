// 단위 검증 — 주차 파트/클래스 저장 후 무효화 결과 → HTTP 응답 판정.
// 실행: npx tsx scripts/verify-week-position-invalidation-outcome.ts
//
// 핵심 불변식(2026-07-22 회귀 방지):
//   무효화가 보장되지 않으면(ok=false / 예외로 null) **저장 요청을 성공으로 응답하지 않는다**.
//   종전 라우트는 예외를 삼키고 항상 success:true 를 돌려줘, 크루앱이 옛 소속/클래스를 계속
//   노출해도 관리자는 알 수 없었다.
import {
  resolveWeekPositionInvalidationOutcome,
  WEEK_POSITION_INVALIDATION_FAILED_MESSAGE,
} from "../lib/weekPositionInvalidationOutcome";
import type { WeeklyCardsInvalidationResult } from "../lib/cluster4WeeklyCardsSnapshot";

let failed = 0;
const check = (name: string, pass: boolean, detail?: string) => {
  if (!pass) failed++;
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` — ${detail}` : ""}`);
};

const base: WeeklyCardsInvalidationResult = {
  mode: "immediate",
  count: 3,
  staleMarked: 3,
  staleFailed: 0,
  recomputed: 3,
  recomputeFailed: 0,
  failedUserIds: [],
  ok: true,
};

// 1) 완전 성공
{
  const o = resolveWeekPositionInvalidationOutcome(base);
  check("완전 성공 → 200 + warning 없음", o.ok && o.status === 200 && o.warning === null, JSON.stringify(o));
}

// 2) stale 은 찍혔고 즉시 재계산만 일부 실패 → 저장 성공이지만 반드시 warning 노출
{
  const o = resolveWeekPositionInvalidationOutcome({
    ...base, recomputed: 1, recomputeFailed: 2, failedUserIds: ["a", "b"],
  });
  check("재계산 부분 실패 → 200 + warning 노출", o.ok && o.status === 200 && !!o.warning, JSON.stringify(o));
  check("warning 에 실패 인원 수 포함", o.ok && (o.warning ?? "").includes("2명"), o.ok ? o.warning ?? "" : "");
}

// 3) stale 마킹 실패(수렴 보장 깨짐) → 저장 실패 처리
{
  const o = resolveWeekPositionInvalidationOutcome({
    ...base, staleMarked: 0, staleFailed: 3, recomputed: 0, recomputeFailed: 3, ok: false,
  });
  check("stale 마킹 실패 → 500", !o.ok && o.status === 500, JSON.stringify(o));
  check("실패 문구 = 공통 메시지", !o.ok && o.error === WEEK_POSITION_INVALIDATION_FAILED_MESSAGE, !o.ok ? o.error : "");
}

// 4) 무효화 자체가 예외로 죽음(폴백 markStale 도 실패) → 저장 실패 처리
{
  const o = resolveWeekPositionInvalidationOutcome(null);
  check("invalidated=null → 500", !o.ok && o.status === 500, JSON.stringify(o));
}

// 5) background/stale_only 모드에서도 stale 만 성공했으면 수렴 보장 → 200
{
  const o = resolveWeekPositionInvalidationOutcome({
    ...base, mode: "stale_only", count: 50, staleMarked: 50, recomputed: 0, recomputeFailed: 0,
  });
  check("stale_only + staleFailed=0 → 200(조회 lazy/cron 이 복구)", o.ok && o.status === 200, JSON.stringify(o));
}

// 6) 성공 응답이 무효화 실패를 숨기지 않는지 — ok=false 는 어떤 조합에서도 200 이 될 수 없다
{
  const combos: WeeklyCardsInvalidationResult[] = [
    { ...base, ok: false },
    { ...base, ok: false, mode: "background" },
    { ...base, ok: false, mode: "stale_only", recomputeFailed: 0 },
    { ...base, ok: false, mode: "none", count: 0 },
  ];
  check("ok=false 조합 전부 500", combos.every((c) => resolveWeekPositionInvalidationOutcome(c).status === 500));
}

console.log(failed === 0 ? "\n✅ 무효화 판정 규칙 전 케이스 통과" : `\n❌ ${failed}건 실패`);
process.exit(failed ? 1 : 0);
