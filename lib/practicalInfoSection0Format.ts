// 실무 정보 라인 개설 [섹션 0] 상태창 표기 포맷 — 순수 함수(browser-safe, DB 무관).
// 컴포넌트와 검증 스크립트가 동일 코드를 공유한다.

export const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

// "26. 07. 06(월)" — 주어진 날짜의 2자리연도. 0패딩 월/일 + 한글 요일.
export function formatToday(d: Date): string {
  const yy = String(((d.getFullYear() % 100) + 100) % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}. ${mm}. ${dd}(${DAY_NAMES[d.getDay()]})`;
}

// "26년, 여름 시즌, 2주차" — seasonName 은 DTO 값("여름 시즌")을 그대로 사용한다.
export function formatBannerPeriod(input: {
  year: number;
  seasonName: string;
  weekNumber: number;
}): string {
  const yy = String(((input.year % 100) + 100) % 100).padStart(2, "0");
  return `${yy}년, ${input.seasonName}, ${input.weekNumber}주차`;
}
