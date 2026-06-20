import { runWithQueryMeter, tickTimeout } from "@/lib/supabaseQueryMeter";

// 대량 조회 API 보호 계측 — 실행 시간 · 처리 건수 · Supabase 쿼리 수 · timeout 발생 횟수를
// 한 줄로 요약 로깅한다. 느린 요청(SLOW_API_MS 초과)은 console.warn 으로 승격해 포화 조짐을
// 빨리 드러낸다. 정확성/제어흐름은 바꾸지 않는다(순수 관측).
//
// 사용(라우트 핸들러 전체를 감싼다):
//   export async function GET(req: NextRequest) {
//     return observeApiRoute("[admin/members/roster GET]", async (obs) => {
//       ...load...
//       obs.processed = data.length;     // 처리 건수(렌더 row 수 등)
//       obs.partialFailures = failed;    // 일부 실패(snapshot error 등) 건수(선택)
//       return Response.json({ success: true, data });
//     });
//   }

// 이 시간을 넘으면 warn 으로 승격(abort 임계 20s 보다 충분히 낮게 잡아 조기 경보).
export const SLOW_API_MS = 8_000;

export type ApiObservation = {
  // 이 요청이 처리한 항목 수(사용자/row 등). 핸들러가 채운다.
  processed?: number;
  // 일부 실패(예: snapshot status:"error")로 제외/폴백된 건수. 핸들러가 채운다(선택).
  partialFailures?: number;
};

export async function observeApiRoute<T>(
  label: string,
  handler: (obs: ApiObservation) => Promise<T>,
): Promise<T> {
  return runWithQueryMeter(label, async (meter) => {
    const startedAt = Date.now();
    const obs: ApiObservation = {};
    let outcome: "ok" | "error" = "ok";
    try {
      return await handler(obs);
    } catch (err) {
      outcome = "error";
      throw err;
    } finally {
      const elapsedMs = Date.now() - startedAt;
      const summary = {
        outcome,
        elapsedMs,
        processed: obs.processed ?? null,
        queries: meter.count,
        timeouts: meter.timeouts,
        partialFailures: obs.partialFailures ?? 0,
      };
      if (elapsedMs >= SLOW_API_MS || meter.timeouts > 0) {
        console.warn(`${label} SLOW/timeout`, summary);
      } else {
        console.log(`${label} done`, summary);
      }
    }
  });
}

// snapshot/배치 조회가 timeout/connection 오류로 실패했을 때 호출(메터 timeout 카운트 증가).
// 메시지 패턴이 timeout/connection 이 아니어도 대량 조회 실패는 포화 신호이므로 동일 집계한다.
export function recordQueryTimeout(): void {
  tickTimeout();
}
