// 라인 개설(line-opening) 하위 전 페이지 공통 콘텐츠 래퍼.
//   대상: practical-info / practical-experience / practical-career /
//         practical-competency / line-history + 모든 하위 탭(?tab=…).
//   폭 상한(과거 max-w-[1400px] 가운데 정렬)을 제거해 사이드바 제외 main 전체 폭을 사용한다 →
//   넓은 모니터에서 좌우 여백 없이 표가 화면 폭을 최대한 쓰고, 폭이 부족할 때만 표 내부 가로 스크롤.
//   min-w-0 으로 자식 매니저의 테이블 overflow-x 스크롤 컨테이너가 그대로 동작하게 한다.
export default function LineOpeningLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="w-full min-w-0">{children}</div>;
}
