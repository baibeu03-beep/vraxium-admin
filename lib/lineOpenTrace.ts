import { beginSpan, formatTrace, runWithPerfTrace, traceSpan } from "@/lib/perfTrace";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";
import { runWithReferenceReadCache } from "@/lib/referenceReadCache";

// ─────────────────────────────────────────────────────────────────────
// 라인 개설/취소 구간 계측 (계측 전용 — 비즈니스 로직·응답 DTO 무영향).
//
// 3허브([라인 개설]/[개설 취소]) write 라우트가 공유하는 단일 계측 진입점이다.
//   · LINE_OPEN_TRACE=1 일 때만 동작. 미설정(운영)이면 traceSpan/withLineOpenTrace 모두
//     no-op 이라 오버헤드 0 — 조건 분기 하나만 남는다.
//   · 켜져 있어도 응답 본문/상태/DB 결과는 완전히 동일하고, 콘솔에 구간(span) 트리 ·
//     쿼리 타임라인 · 중복 쿼리 · 테이블 fan-out · 병목 랭킹만 추가 출력한다.
//
// 구간 이름(stage)은 3허브가 같은 어휘를 쓴다 — 허브별 개설/취소 비용을 같은 축으로 비교하기 위함.
//   auth/scope · loadExisting · validate · loadDomain · persist · snapshot · derive ·
//   invalidate · log · responseDto
// (weekly-cards 조회 트레이스와 동일한 perfTrace 인프라를 재사용한다 — 새 계측 체계를 만들지 않는다.)
// ─────────────────────────────────────────────────────────────────────

export const LINE_OPEN_TRACE_ENABLED = process.env.LINE_OPEN_TRACE === "1";

/** 라인 개설/취소 구간 마커. 트레이스 비활성이면 fn 을 그대로 실행(오버헤드 0). */
export function lineOpenStage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return traceSpan(name, fn);
}

/** 조기 return 이 섞인 선형 구간용 수동 마커. `const end = lineOpenMark("weekPolicy"); … end();`
 *  이름을 닫을 때 정해도 된다: `const end = lineOpenMark(); … end("weekPolicy")`. */
export function lineOpenMark(name?: string): (closeName?: string) => void {
  return beginSpan(name);
}

// 라인 개설/취소 write 라우트 핸들러 전체를 감싼다.
//   (1) 참조 테이블 읽기 공유 캐시 — 같은 요청에서 weeks/activity_types/user_profiles 등을 다시 읽지 않는다.
//       ⚠ 계측 스위치와 무관하게 **항상** 적용된다(성능 개선분이며, 쓰기 테이블은 캐시 대상이 아니다).
//   (2) 쿼리 메터(기존) · (3) LINE_OPEN_TRACE=1 일 때만 구간 트레이스 출력.
export async function withLineOpenTrace<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const run = () =>
    runWithReferenceReadCache(
      () => runWithQueryMeter(label, () => fn()),
      (stats) => {
        if (stats.hits > 0) {
          console.log(
            `${label} reference read cache`,
            `sharedHits=${stats.hits} realGets=${stats.misses}`,
          );
        }
      },
    );
  if (!LINE_OPEN_TRACE_ENABLED) return run();
  const { result, trace } = await runWithPerfTrace(label, run);
  console.log(`\n${formatTrace(trace)}\n`);
  return result;
}
