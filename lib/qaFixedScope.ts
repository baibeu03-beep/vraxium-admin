// QA 고정 모집단 필터 (2026-07-01 ~ QA 종료) — 단일 SoT 스위치.
// ─────────────────────────────────────────────────────────────────────
// 목적: 별도 QA 배포/URL mode=test/체크박스 없이도, "현재 운영 사이트"의 어드민 화면·API 가
//   QA 기간 동안 항상 test_user_markers 테스트 유저/테스트 크루만 보이게 한다(실사용자 노출 0).
//
// 동작:
//   · QA_FIXED_TEST_ONLY === true  → resolveUserScope 가 전달 mode 와 무관하게 "test" 모집단으로
//       고정한다. 모든 집계(crews·members·weekly-ranking·week-recognition·growth·cluster4 cards·
//       snapshot 코호트·write 게이트)가 lib/userScope.ts 한 곳을 거치므로, 이 상수 하나로 전 화면이
//       테스터 전용이 된다. 별축 경로(finalization 코호트·publish 재계산·growth-status-batch)는
//       각 파일에서 이 상수를 직접 참조해 동일하게 좁힌다.
//   · QA_FIXED_TEST_ONLY === false → 종전 동작(전달 mode 기준 operating/test) 그대로.
//
// ⚠ 이 스위치는 외부 환경변수/배포 분기에 의존하지 않는 순수 상수다 — QA 종료 시 false 로 바꾸면
//   (또는 이 파일을 제거하고 각 참조부를 되돌리면) 운영 동작으로 즉시 복귀한다.
//
// ⚠ snapshot-only 조회 구조·demoUserId(고객 데모) 단건 DTO 경로는 이 스위치가 건드리지 않는다.
//   userScope 는 "누구를 모집단에 넣을지"만 판정하므로 DTO·스냅샷 구조는 불변이다.
// ─────────────────────────────────────────────────────────────────────

export const QA_FIXED_TEST_ONLY = true;
