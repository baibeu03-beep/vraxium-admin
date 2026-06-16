# 스코프 중앙화 — 신규 API 체크리스트

LineScope(`lib/lineScope.ts`)와 RequestScope(`lib/requestScope.ts`)는 org/mode/demoUserId/라인 org 가시성
판정의 단일 출처(SoT)다. **신규 또는 수정되는 `app/api/**/route.ts` 는 아래를 우회하면 안 된다.**

자동 강제: `npm run verify:scope-helper-usage` (정적 가드 · DB/서버 불필요).
회귀 검증: `npm run verify:scope-centralization` (dev 서버 + `INTERNAL_API_KEY` + `.env.local` 필요).
둘 다: `npm run verify:scope`.

## 데모/스코프 해소 (RequestScope)

- [ ] 데모 인증·org·mode·조회 대상(userId)은 `resolveRequestScope(request)` 로 해소한다.
- [ ] 라우트에서 `resolveDemoProfileUserId` 를 **직접 import/호출하지 않는다** (헬퍼 내부에서만 호출).
- [ ] foreign viewer 규칙: 조회 대상은 `requestScope.targetUserId` 우선, 없으면 `requestScope.demoUserId`.
- [ ] `searchParams.get("userId")` 를 직접 파싱하지 않고 `requestScope.targetUserId` 를 쓴다
      (세션/internal-key 경로에서 불가피하면 사유를 주석으로 남긴다).

## 라인 org 가시성 (LineScope)

- [ ] 라인 org 판정은 `resolveLineScope(dbRow)` 또는 `resolveLineScopeFromValues(values)` 로 한다.
- [ ] 가시성 비교는 `isLineScopeVisibleForOrg(scope, userOrg, { allowUnknown })` 로 한다.
- [ ] 라우트에서 `parseLineCodeOrg` / `isLineVisibleForUserOrg` / `normalizeLineOrg` 를
      `@/lib/cluster4LineOrg` 에서 **직접 import 하지 않는다**.
- [ ] 판정 불가(`scope.unknown`)는 fail-closed(숨김). info 라인의 line_code 토큰 부재는 더 이상 'common' 자동승격이 아니다.

## DTO 일관성

- [ ] mode(`operating`/`test`)·demoUserId 는 "조회 대상/스코프"만 바꾸고 DTO 형상은 바꾸지 않는다.
- [ ] 4허브 카드는 snapshot-only 로더(`loadWeeklyCards`)만 사용한다 (live 분기 신설 금지).
- [ ] 라인 가시성/배정 분모를 바꾸는 write 는 영향 사용자 snapshot 을 즉시 invalidate 한다.

## 정당한 예외

- live DTO 의도 API(snapshot 아님): `cluster1/resume`, `cluster3/club-rank`, `cluster3/stats-cards`,
  `cluster4/weekly-growth`(실시간) — 이들은 RequestScope 의 demo 분기만 쓰고 카드 snapshot 로더를 쓰지 않는다.
- 가드 예외가 정말 필요하면 `scripts/verify-scope-helper-usage.ts` 의 `ALLOWLIST` 에 상대경로 + 사유를 남긴다.
