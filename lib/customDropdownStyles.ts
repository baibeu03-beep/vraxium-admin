// 커스텀 absolute 드롭다운(공통 base-ui `<Select>` 를 쓰지 않는 주차 선택 등)의 팝업 폭 SoT.
//
// 공통 `components/ui/select.tsx` 의 `SelectContent` 와 **동일 원칙**을 재사용한다
// (base-ui Select 팝업 폭 SoT: project_admin-dropdown-width-sot):
//   - w-max                    : 내용(가장 긴 옵션의 한 줄) 만큼만 확장.
//                                고정폭(w-[280px]/w-full)으로 인한 강제 줄바꿈을 없앤다.
//   - min-w-full               : 트리거(= `relative` 부모) 폭 이상 확보 — 트리거보다 좁아지지 않음.
//   - max-w-[calc(100vw-2rem)] : 뷰포트 상한 — 모바일에서 가로 스크롤/화면 밖 잘림 방지.
//   - overflow-x-hidden        : max-w 로 좁혀졌을 때만 옵션 텍스트가 (기본 whitespace-normal 로)
//                                단어 경계에서 줄바꿈되게 하고, 넘치는 픽셀은 숨긴다(가로 스크롤 0).
//   - max-h                    : 세로축 공통 SoT 변수 재사용(project_admin-dropdown-max-height-sot,
//                                7행 + 내부 세로 스크롤).
//
// 옵션 각 행(주차명 행 / 날짜범위 행)은 `whitespace-normal`(기본값) 을 그대로 둔다:
//   데스크톱 → w-max 가 "가장 긴 한 줄" 폭을 확보하므로 각 행은 한 줄로 렌더(불필요한 줄바꿈 없음),
//   모바일  → max-w 에 걸릴 때만 단어 경계에서 줄바꿈(말줄임/클리핑 없음).
// 의도한 2줄 구조(1행 주차명 / 2행 날짜)는 각 행이 별도 block 이므로 그대로 유지된다.
//
// 주의: 이 커스텀 드롭다운들은 좌측 앵커(플렉스 좌측/그리드 첫 칸)라서 우측으로 확장해도
// 카드/뷰포트를 침범하지 않는다. base-ui 처럼 collision 자동 좌측정렬은 없으므로,
// 우측단 앵커에 새로 쓸 때는 공통 `<Select>` 사용을 우선 검토할 것.
export const CUSTOM_DROPDOWN_POPUP_CLASS =
  "absolute z-20 mt-1 max-h-(--admin-dropdown-max-height) w-max min-w-full max-w-[calc(100vw-2rem)] overflow-x-hidden overflow-y-auto overscroll-contain rounded-md border bg-background py-1 shadow-md"
