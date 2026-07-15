// 팀 탭/팀명 표시 공통 포맷 — 순수 함수(browser-safe, DB 무관).
//
// 라인 개설(line-opening) 하위 전 화면의 팀 탭은 팀명 끝에 "팀"을 붙여 표시한다.
//   예: "운영(T)" → "운영(T) 팀", "전략(T)" → "전략(T) 팀".
// 단, 실제 팀명 데이터에 이미 "팀"이 포함(끝에 위치)된 경우엔 "팀 팀"처럼 중복 부착하지 않는다.
//   예: "운영팀" → "운영팀", "운영 팀" → "운영 팀".
// 페이지마다 문자열을 직접 조합하지 않도록 이 함수를 공통으로 사용한다.
export function formatTeamTabLabel(teamName: string | null | undefined): string {
  const name = (teamName ?? "").trim();
  if (!name) return "-";
  return /팀$/.test(name) ? name : `${name} 팀`;
}
