/**
 * QA 기준 활동일(시간여행) — direct 검증.
 *   DB 테이블(qa_clock_state) 없이도 핵심 Resolver/ALS 전파를 검증한다(fail-open 포함).
 *
 *   npx tsx --env-file=.env.local scripts/verify-qa-clock.ts
 */
import { AsyncResource } from "node:async_hooks";
import {
  getCurrentActivityDateIso,
  getCurrentActivityNowMs,
  getCurrentActivityDate,
  getSeasonForDate,
  seasonDbKey,
} from "@/lib/seasonCalendar";
import { getCurrentWeekStartMs, getOpenableWeekStartMs } from "@/lib/cluster4WeekPolicy";
import { seedQaClockMs, runWithQaClock, loadQaClockMs, seedQaClock } from "@/lib/qaClock";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

async function main() {
  const realNow = Date.now();
  const realIso = getCurrentActivityDateIso(realNow);

  console.log("── 1) 미시드(운영) = 실시간 ──");
  check(
    "getCurrentActivityNowMs() ≈ Date.now()",
    Math.abs(getCurrentActivityNowMs() - realNow) < 5_000,
  );
  check("getCurrentActivityDateIso() == 실시간 ISO", getCurrentActivityDateIso() === realIso);

  console.log("── 2) loadQaClockMs fail-open(테이블 부재 → null, throw 없음) ──");
  let loadErr = false;
  let loaded: number | null = null;
  try {
    loaded = await loadQaClockMs();
  } catch {
    loadErr = true;
  }
  check("loadQaClockMs() throw 없음", !loadErr);
  check("loadQaClockMs() == null (미적용/비활성)", loaded === null, `got=${loaded}`);

  console.log("── 3) seedQaClock('operating') = no-op(운영 무시) ──");
  await seedQaClock("operating");
  check("operating 시드 후에도 실시간", getCurrentActivityDateIso() === realIso);

  console.log("── 4) 미래 시각 시드 → 모든 현재-시각 logic 전파 ──");
  // 2026 여름 W1 부근(미래) — 시즌/주차가 분명히 달라지는 시각.
  const futureMs = Date.parse("2026-08-15T12:00:00+09:00");
  const futureIso = getCurrentActivityDateIso(futureMs);
  const futureSeason = getSeasonForDate(futureIso);

  runWithQaClock(futureMs, () => {
    check("getCurrentActivityNowMs() == futureMs", getCurrentActivityNowMs() === futureMs);
    check("getCurrentActivityDateIso() == future ISO", getCurrentActivityDateIso() === futureIso);
    check(
      "getCurrentActivityDate() == future Date",
      getCurrentActivityDate().getTime() === futureMs,
    );
    const seasonNow = getSeasonForDate(getCurrentActivityDateIso());
    check(
      "현재 시즌이 future 시즌 추종",
      !!seasonNow && !!futureSeason && seasonDbKey(seasonNow) === seasonDbKey(futureSeason),
      `now=${seasonNow ? seasonDbKey(seasonNow) : null} future=${futureSeason ? seasonDbKey(futureSeason) : null}`,
    );
    // 주차 정책(현재/개설대상 주차)도 인자 없이 현재 시각을 읽으면 future 추종.
    const wkNow = getCurrentWeekStartMs(getCurrentActivityDateIso());
    const wkFuture = getCurrentWeekStartMs(futureIso);
    check("getCurrentWeekStartMs 추종", wkNow === wkFuture, `now=${wkNow} future=${wkFuture}`);
    const openNow = getOpenableWeekStartMs(getCurrentActivityDateIso());
    const openFuture = getOpenableWeekStartMs(futureIso);
    check("getOpenableWeekStartMs 추종", openNow === openFuture);
  });

  console.log("── 5) 컨텍스트 종료 후 누수 없음(실시간 복귀) ──");
  check("runWithQaClock 밖에서 실시간 복귀", getCurrentActivityDateIso() === realIso);

  console.log("── 6) 요청 격리: 한 요청의 enterWith 가 다른 요청에 누수되지 않음 ──");
  // 실제 HTTP 핸들러는 서버의 (깨끗한) listening 컨텍스트에서 매 요청 새로 호출된다 —
  //   AsyncResource(생성 시점 컨텍스트 캡처)로 그 모델을 재현한다. requireAdmin 의 seedQaClock
  //   (enterWith)은 그 요청의 async 자손에만 적용되고 형제 요청에는 영향이 없어야 한다.
  function asRequest<T>(fn: () => T): Promise<T> {
    const res = new AsyncResource("qa-req-sim"); // main(실시간) 컨텍스트 캡처
    return new Promise((resolve) => {
      setImmediate(() => resolve(res.runInAsyncScope(fn)));
    });
  }
  const reqQa = await asRequest(() => {
    seedQaClockMs(futureMs); // QA 요청: 시드
    return getCurrentActivityDateIso();
  });
  const reqOperating = await asRequest(() => getCurrentActivityDateIso()); // 운영 요청: 미시드
  check("QA 요청은 future 추종", reqQa === futureIso, `got=${reqQa}`);
  check(
    "운영 요청은 실시간(누수 없음)",
    reqOperating === realIso,
    `got=${reqOperating} expected=${realIso}`,
  );
  check("메인 컨텍스트 실시간 유지", getCurrentActivityDateIso() === realIso);

  console.log("");
  console.log(`RESULT: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
