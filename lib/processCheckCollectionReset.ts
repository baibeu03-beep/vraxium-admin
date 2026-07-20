// 프로세스 체크 "완료 취소 / 재검수 준비"(명시적 un-complete) 시 이전 검수 시도의 진단값 초기화 정책 — 공용 SoT.
//
//   정규(process_check_statuses)·변동(process_irregular_acts) 두 테이블은 동일 컬럼명을 쓰므로 정책을 공유한다.
//   관리자가 기존 완료를 "의도적으로 되돌리고 새 검수 주기를 시작"하는 경로에서만 사용한다:
//     · rollbackProcessCheckCompletion       (정규 완료 → 필요)
//     · applyProcessCheckAction request/cancel(정규 재신청·신청취소)
//     · rollbackIrregularAct                  (변동 완료 → 대기)
//
//   목적: 취소된 과거 결과(수집 댓글 수·수집 상태·오류)가 이후 재검수의 "최신 결과"처럼 DTO 에 노출되는 것을
//     막는다. 되돌린 뒤에는 다음 재검수(sweep 성공/실패)가 이번 시도의 값으로 새로 각인한다.
//
//   ⚠ 재수집(recollect) 실패 경로에는 절대 쓰지 않는다 — 그건 기존 정상 결과(raw_comment_count·recipients)를
//     보존해야 한다(processCheckDueSweep 실패 브랜치가 수집 3컬럼·recipients 를 무접촉). 이 초기화는 "취소"에만.
//
//   컬럼 가드: raw_comment_count/comment_collection_status/comment_collection_error_code 는 2026-07-19
//     마이그레이션 컬럼이라 미적용 DB 에서 update 에 넣으면 "column does not exist" 로 전체 update 가 깨진다.
//     → 가용 여부(collectionAvailable)를 받아 조건부로만 포함한다(미적용이면 last_error 만 초기화).

// 항상 존재하는 base 컬럼(마이그레이션 무관) — 되돌릴 때 마지막 오류를 지운다.
//   두 테이블 모두 last_error 를 가진다(STATUS_SELECT_BASE / ROW_SELECT 포함).
const BASE_RESET = { last_error: null } as const;

// 수집 진단 3컬럼 초기화(컬럼 적용 시에만). available=false 면 빈 객체(degrade — last_error 만 초기화).
type CollectionResetFields = {
  raw_comment_count: null;
  comment_collection_status: null;
  comment_collection_error_code: null;
};
export function collectionResetFields(
  available: boolean,
): CollectionResetFields | Record<string, never> {
  if (!available) return {};
  return {
    raw_comment_count: null,
    comment_collection_status: null,
    comment_collection_error_code: null,
  };
}

// un-complete stamp 에 병합할 전체 초기화 필드(base + 수집). 각 경로가 자신의 status/기타 필드에 스프레드한다.
//   예: update({ status: "needed", ...uncompleteResetStamp(available) })
export function uncompleteResetStamp(collectionAvailable: boolean): Record<string, null> {
  return { ...BASE_RESET, ...collectionResetFields(collectionAvailable) };
}
