// 프로세스 체크(/admin/integrated/processes/check/*)의 "체크 방식 선택" 버튼 색 SoT — **스타일 전용**.
//   같은 한 쌍([링크 신청] / [수동 부여])이 두 화면에서 반복된다:
//     · ProcessCheckManager        — 선별 액트 "체크 필요" 클릭 시 선택 모달
//     · ProcessIrregularManager    — [부분] 클릭 시 방식 선택 모달(PartialChoiceDialog)
//   기존에는 두 곳이 각각 라이트 전용 클래스(bg-purple-50 / bg-green-50)를 복붙하고 있어 다크에서
//   배경이 그대로 밝게 남았다. 색 정의를 여기 하나로 모아 두 화면이 동일하게 쓰도록 한다.
//
//   색 의미(전역 규약 유지): 링크 신청 = 보라(카페 글 기반 · worker 검수) / 수동 부여 = 초록(직접 부여).
//   ⚠ 버튼의 크기·여백·문구·onClick·권한은 호출부가 소유한다 — 이 파일은 색만 제공한다.
//   ⚠ mode(operating/test)·org 로 분기하지 않는다.

/** [링크 신청] 버튼 — 보라 계열(라이트/다크 대응). 호출부의 골격 클래스 뒤에 합성한다. */
export const CHECK_METHOD_LINK_BUTTON_CLASS =
  "border-purple-300 bg-purple-50 text-purple-800 hover:bg-purple-100 dark:border-purple-700 dark:bg-purple-950/40 dark:text-purple-200 dark:hover:bg-purple-900/50";

/** [링크 신청] 버튼의 보조 설명 텍스트 색. */
export const CHECK_METHOD_LINK_SUB_CLASS = "text-purple-600 dark:text-purple-300";

/** 링크 신청 모달의 안내 박스(보라 계열) — 성공/오류가 아닌 '방식 설명'이라 tone SoT 밖의 보라를 쓴다. */
export const CHECK_METHOD_LINK_NOTICE_CLASS =
  "border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-800 dark:bg-purple-950/35 dark:text-purple-200";

/** 링크 신청 모달 제목 안 '링크 신청' 강조 텍스트 색. */
export const CHECK_METHOD_LINK_TITLE_CLASS = "text-purple-700 dark:text-purple-300";

/** [수동 부여] 버튼 — 초록 계열(라이트/다크 대응). */
export const CHECK_METHOD_GRANT_BUTTON_CLASS =
  "border-green-300 bg-green-50 text-green-800 hover:bg-green-100 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200 dark:hover:bg-green-900/50";

/** [수동 부여] 버튼의 보조 설명 텍스트 색. */
export const CHECK_METHOD_GRANT_SUB_CLASS = "text-green-600 dark:text-green-300";

// ── 변동 액트 대상 범위([전원] / [부분]) 색 SoT ──────────────────────────────────────────────
//   ProcessIrregularManager(설명 문구·신청 버튼·행 배지)와 ProcessIrregularDialog(대상 배지)가
//   같은 색을 써야 한다. 전원 = 파랑(정보/전체) · 부분 = 주황(선별). 라이트/다크 모두 대비 확보.
export type IrregularTargetKind = "all" | "partial";

/** 문장 안 강조 텍스트 색([전원]/[부분]). */
export const IRREGULAR_TARGET_TEXT_CLASS: Record<IrregularTargetKind, string> = {
  all: "text-blue-700 dark:text-blue-300",
  partial: "text-orange-700 dark:text-orange-300",
};

/** 신청 버튼(파스텔 배경 + 같은 계열 테두리 + 진한 텍스트 + hover). */
export const IRREGULAR_TARGET_BUTTON_CLASS: Record<IrregularTargetKind, string> = {
  all: "border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/50",
  partial:
    "border-orange-300 bg-orange-50 text-orange-800 hover:bg-orange-100 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-200 dark:hover:bg-orange-900/50",
};

/** 표 행·모달의 대상 배지(hover 없음). */
export const IRREGULAR_TARGET_BADGE_CLASS: Record<IrregularTargetKind, string> = {
  all: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200",
  partial:
    "border-orange-300 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-950/40 dark:text-orange-200",
};
