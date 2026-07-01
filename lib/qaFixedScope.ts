// QA "실사용자 숨김" 모집단 스위치 (2026-07-01 ~ QA 종료) — 단일 SoT.
// ─────────────────────────────────────────────────────────────────────
// 정책(확정 2026-07-01): 운영과 QA는 "같은 로직"을 쓴다. QA 기간에 달라지는 것은 오직 하나 —
//   "사용자 조회(사람을 보여주는 화면)와 그 write 대상 모집단"뿐이다.
//
//   · 정책 / 시즌 / 주차 / 라인 / 프로세스 / snapshot / publish / 자동화 / URL = 항상 operating.
//     → 이 축들은 절대 test 로 분기하지 않는다(W13 예외 같은 "테스트 전용 정책"은 쓰지 않는다).
//   · 사용자 조회(user list · crew list · target picker · 검색 · 선택창) + 그 write 대상 모집단
//     = QA 기간엔 실사용자를 숨기고 test_user_markers 테스트 유저만 보이게/쓰이게 한다.
//
//   즉 이것은 "test mode 로 동작"하는 게 아니라 "operating 로직을 테스터 모집단에 적용"하는 것이다.
//   화면에 보이는 사용자와 실제 처리(write) 대상은 항상 동일해야 한다(picker == write target).
//
// 동작:
//   · QA_HIDE_REAL_USERS === true  → resolveUserScope 가 전달 mode 와 무관하게 test 모집단으로
//       고정한다. 사람 모집단이 한 곳(lib/userScope.ts)을 거치므로, 이 상수 하나로 표시·write
//       대상이 함께 테스터 전용이 된다. 별축 population 경로(finalization 코호트·publish 재계산·
//       growth-status-batch·팀 드롭다운)도 각 파일에서 이 상수를 직접 참조해 동일하게 좁힌다.
//   · QA_HIDE_REAL_USERS === false → 실사용자 모집단으로 복귀. 운영 로직은 아무것도 바뀌지 않는다.
//
// ⚠ 이 스위치는 "누구를 모집단에 넣을지"만 판정한다 — DTO·snapshot 구조·주차/시즌/publish 알고리즘·
//   자동화 파이프라인은 이 상수와 무관하게 operating 그대로다. QA 종료 시 false 한 줄로 즉시 복귀.
//
// ⚠ snapshot-only 조회 구조·demoUserId(고객 데모) 단건 DTO 경로는 이 스위치가 건드리지 않는다.
// ─────────────────────────────────────────────────────────────────────

export const QA_HIDE_REAL_USERS = true;
