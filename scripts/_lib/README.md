# scripts/_lib

DB 를 건드리는 진단(diag)/검증(verify)/백필 스크립트가 **동시에 실행되어 Supabase 연결풀·
PostgREST 가 포화**되는 사고를 막기 위한 공용 유틸.

## scriptLock — 동시 실행 방지 락

DB 를 조회/수정하는 모든 ad-hoc 스크립트는 맨 위에서 락을 잡는다. 같은 키
(`vraxium-db-scripts`)를 공유하므로 한 번에 하나만 돈다.

```ts
import { acquireScriptLock } from "./_lib/scriptLock";

async function main() {
  const lock = await acquireScriptLock("diag-내-스크립트-이름");
  try {
    // ...DB 작업...
  } finally {
    lock.release();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
```

동작:
- 다른 스크립트가 이미 실행 중(락 보유 + PID 생존 + 30분 내 신선)이면 **즉시 거부**(exit 1).
- 죽은 PID / 30분 초과 좀비 락은 자동 회수.
- 2분 초과 실행 시 60초마다 **장시간 실행 경고** 출력(대량 루프 점검 신호).
- exit / SIGINT / SIGTERM / uncaughtException 시 락 자동 해제.

독립적으로 돌려야 하는 스크립트는 `acquireScriptLock(name, { key: "다른-키" })` 로 별도 키 사용.

## 관련 런타임 가드(앱 측)

- `lib/concurrency.ts` — `mapWithConcurrency(items, GROWTH_CARD_CONCURRENCY=8, fn)`.
  대량 배치의 per-user 비동기 작업을 무제한 팬아웃하지 않고 동시 8개로 묶는다.
- `lib/apiObservability.ts` — `observeApiRoute(label, handler)`. 대량 조회 API 의 실행 시간 ·
  처리 건수 · 쿼리 수 · timeout 발생 횟수를 한 줄 요약 로깅(느린 요청은 warn 승격).
- `lib/supabaseQueryMeter.ts` — 요청 단위 쿼리/timeout 카운터(AsyncLocalStorage).

## 포화 재현 검증

```
npm run verify:batch-saturation-guard
# direct==HTTP 동등성까지: PERF_BASE_URL=http://localhost:3000 npm run verify:batch-saturation-guard
```

50 / 100 / 300+ 규모에서 배치 함수가 timeout 없이 완료되는지, direct function 결과가 실제
HTTP API 응답과 일치하는지 실측한다(조회 전용 — snapshot 무접촉).
