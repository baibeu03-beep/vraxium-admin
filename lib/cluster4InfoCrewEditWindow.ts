// 실무 정보 라인 — "개설 대상 크루 수정" 허용 주차 범위 SoT (browser-safe).
//
// 이미 개설된 과거 라인의 개설 대상 크루를 카페 검수 UI 로 사후 수정할 수 있는 주차 범위.
//   허용: 25 겨울 1주차 ~ 26 봄 11주차 (그 외 = fail-closed).
//
// 경계값(weeks 테이블 실측, 2026-06-21 확인):
//   25 겨울 W1 시작 = 2024-12-30
//   26 봄  W11 종료 = 2026-05-17
// date-only ISO 문자열은 사전식 비교가 곧 시간순 비교라 문자열 비교로 안전하게 판정한다.
// 서버(API 게이트)·클라이언트(버튼 노출)가 동일 함수를 공유해 두 경로의 정책이 갈라지지 않는다.

export const INFO_CREW_EDIT_WINDOW_START = "2024-12-30"; // 25 겨울 W1 시작
export const INFO_CREW_EDIT_WINDOW_END = "2026-05-17"; // 26 봄 W11 종료
export const INFO_CREW_EDIT_WINDOW_LABEL = "25 겨울 1주차 ~ 26 봄 11주차";

// 주차의 시작/종료일(date-only ISO)이 허용 범위 안에 완전히 포함되는지.
//   - startDate 가 없으면 판정 불가 → false(fail-closed).
//   - endDate 가 없으면 startDate 로 대체(단일 일자 보호).
export function isInfoCrewEditableWeek(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): boolean {
  const start = (startDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return false;
  const end = ((endDate ?? startDate) ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  return start >= INFO_CREW_EDIT_WINDOW_START && end <= INFO_CREW_EDIT_WINDOW_END;
}
