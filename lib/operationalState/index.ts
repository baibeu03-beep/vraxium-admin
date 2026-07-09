// ─────────────────────────────────────────────────────────────────────
// Operational State Provider (server-only) — QA 오버레이 일반 골격.
//
// 목적: "시간이 지나야 일어나는 운영 액션"(공표·검수완료·확정·체크기준)의 결과 상태를
//   운영(operating) DB 와 QA(qa) 오버레이로 분리해 읽고/쓰는 단일 SoT.
//
// 핵심 원칙(설계안):
//   - 로직은 공통, 분기는 "상태 저장소"만. Action 로직(가드/멱등/재계산)은 호출부 1벌,
//     본 모듈은 operating/qa 테이블 분기 + 감사 로깅만 캡슐화한다.
//   - 읽기 스코프 = "대상 유저가 test_user_marker 인가"에서 파생(resolveStateScopeForUser).
//     테스트 유저 → qa 오버레이 우선(COALESCE 로 운영 baseline 상속) · 실유저 → 운영만.
//   - 쓰기 스코프 = 어드민 요청의 mode=test → qa (resolveStateScopeFromRequest).
//   - operating 분기는 본 모듈을 거치지 않거나(직접 weeks 읽기 유지) qa 쿼리를 0회 수행 →
//     운영 동작 바이트 동일.
//
// 일반화: 주차상태(weekResultState)는 첫 번째 "도메인"일 뿐이다. 향후 다른 운영 상태
//   (시즌/라인 등)도 동일 인터페이스(read overlay + scoped writer + qa_action_log)로
//   파일만 추가하면 되며 본 골격(스코프 해석·감사)은 불변이다.
// ─────────────────────────────────────────────────────────────────────

import type { NextRequest } from "next/server";
import { isTestUser } from "@/lib/testUsers";
import { readScopeMode } from "@/lib/userScopeShared";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";

// 운영 상태 해석/기록 스코프. test_user_markers 축(operating|test)과 1:1 매핑하되,
// "운영 상태 저장소"라는 의미를 분명히 하려고 별도 명명(operating|qa)을 쓴다.
export type StateScope = "operating" | "qa";

// ⚠ QA_HIDE_REAL_USERS 기간(=현재 QA 정책) 단일 저장소 강제 (2026-07-09):
//   qaFixedScope.ts 확정 정책 — "정책/시즌/주차/라인/프로세스/snapshot/publish/자동화 = 항상 operating,
//   QA 기간에 달라지는 건 오직 '사용자 모집단'뿐"이다. 따라서 상태 저장/해석 스코프도 항상 operating 으로
//   고정하고, qa_weeks_state 오버레이(이중 저장소)는 타지 않는다. 모집단 test 한정은 QA_HIDE_REAL_USERS
//   ∨ 코호트 로더가 이미 담당한다(스코프와 무관).
//   배경(실측 2026-07-09): mode=test → scope=qa 로 공표/검수를 qa_weeks_state 에만 쓰면, 고객 read 는
//   COALESCE(qa, operating) 이라 operating 공표 플래그만 남고 uws 가 되돌려진 혼합 상태에서 과거 주차가
//   no_data 로 드롭(카드 사라짐)됐다. write=operating / read=operating 로 통일해 이 트랩을 제거한다.
//   QA 종료 시 QA_HIDE_REAL_USERS=false 한 줄로 종전(이중 저장소) 동작이 자동 복귀한다.
const FORCE_OPERATING_STATE_SCOPE = QA_HIDE_REAL_USERS;

// 단건 유저의 상태 스코프 파생: 데모 대상(test_user_markers 등재) = qa, 그 외 = operating.
//   조회 실패 시 isTestUser 가 false → operating (보수적: 실유저 경로 보존).
//   QA_HIDE_REAL_USERS 기간에는 test 유저여도 operating 으로 고정 → 고객 read 가 qa 오버레이를 타지 않고
//   operating weeks 단일 baseline 만 읽는다(잔존 qa_weeks_state 행 무시).
export async function resolveStateScopeForUser(
  userId: string,
): Promise<StateScope> {
  if (FORCE_OPERATING_STATE_SCOPE) return "operating";
  return (await isTestUser(userId)) ? "qa" : "operating";
}

// mode 문자열("test" 만 qa) → 스코프. 그 외(null/오타/미설정)는 fail-safe operating.
//   QA_HIDE_REAL_USERS 기간에는 mode=test 여도 operating(단일 저장소).
export function resolveStateScopeFromMode(
  mode: string | null | undefined,
): StateScope {
  if (FORCE_OPERATING_STATE_SCOPE) return "operating";
  return mode === "test" ? "qa" : "operating";
}

// 어드민 write 요청의 ?mode=test → qa. userScopeShared.readScopeMode 재사용(단일 파싱 SoT).
//   QA_HIDE_REAL_USERS 기간에는 mode=test 여도 operating write(공표/검수/검수기준 = operating weeks).
export function resolveStateScopeFromRequest(request: NextRequest): StateScope {
  if (FORCE_OPERATING_STATE_SCOPE) return "operating";
  return readScopeMode(request.nextUrl.searchParams) === "test"
    ? "qa"
    : "operating";
}

export {
  // 읽기 오버레이 (compute 경로용)
  applyQaWeekPublishOverlay,
  fetchQaWeekCheckThresholdMap,
  // 저수준 qa 상태 read/write (Action Service 가 가드와 함께 호출)
  readQaWeekState,
  writeQaWeekState,
  // 자동 sweep 재공표 보류(실행 취소 시 set, 재공표 시 clear)
  setWeekAutoPublishHold,
  logQaAction,
  type QaWeekStateRow,
  type QaActionName,
} from "@/lib/operationalState/weekResultState";
