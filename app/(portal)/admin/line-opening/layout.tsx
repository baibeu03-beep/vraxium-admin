// 라인 개설(line-opening) 하위 전 페이지 공통 콘텐츠 폭 제한.
//   대상: practical-info / practical-experience / practical-career /
//         practical-competency / line-history + 모든 하위 탭(?tab=…).
//   1920px 모니터 기준 약 70~75% 폭으로 가운데 정렬 — 시선 이동 축소 + 정보량 균형.
//   폭 컨테이너만 추가한다(가운데 정렬). 카드/테이블 내부 레이아웃·데이터·API 무관.
//   min-w-0 으로 자식 매니저의 테이블 overflow-x 스크롤 컨테이너가 그대로 동작하게 한다.
export default function LineOpeningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="mx-auto w-full min-w-0 max-w-[1400px]">{children}</div>;
}
