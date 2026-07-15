// 라인 개설(line-opening) 하위 전 허브 공통 결과 알림 문구 SoT — 순수 상수(browser-safe).
//
// 원칙:
//   · 사용자(운영자)에게는 "액션 성공 여부"만 노출한다.
//   · 개발자용 상세(라인/대상/평가 수, 경고 개수·문자열, UUID·내부 ID, 후보 개수·코드,
//     "첫 후보 사용" 처리 과정, 사용자별 제외 사유, stack trace, 원본 서버 메시지 전체)는
//     toast/화면 알림에 절대 넣지 않는다 — 필요 시 console(개발자 로그)에만 남긴다.
//   · 표시는 페이지 상단 인라인 박스가 아니라 하단 toast(useToast)로 통일한다.
//
// 동일 액션은 /admin/line-opening 하위 어느 허브(정보/경험/역량/경력)에서 실행하든 같은 문구를 쓴다.
export const LINE_OPENING_RESULT = {
  // 라인 개설 완료(개설 완료/최종 개설/역량·경력 라인 생성 등 "실제 개설" 성공).
  openSuccess: "개설이 완료되었습니다.",
  // 개설은 완료됐지만 운영자의 별도 확인이 필요한 경우(상세는 표시하지 않음).
  openSuccessNeedsAttention: "개설이 완료되었습니다. 일부 항목은 확인이 필요합니다.",
  // 개설 신청(파트장 신청 등).
  applySuccess: "개설 신청이 완료되었습니다.",
  applyCancelSuccess: "개설 신청이 취소되었습니다.",
  // 개설 검수(에이전트 임시 저장 검수).
  reviewSuccess: "개설 검수가 완료되었습니다.",
  // 입력값 초기화(프론트 전용).
  resetSuccess: "초기화가 완료되었습니다.",
  // 개설 취소(완료 원복).
  cancelSuccess: "개설 취소가 완료되었습니다.",
} as const;

// 개설 완료 성공 문구 — 운영자 확인이 필요한 경고가 있으면 needs-attention, 아니면 기본 성공.
//   (경고 상세 자체는 호출부에서 console 로만 남기고 문구에는 넣지 않는다.)
export function lineOpenSuccessMessage(hasWarnings: boolean): string {
  return hasWarnings
    ? LINE_OPENING_RESULT.openSuccessNeedsAttention
    : LINE_OPENING_RESULT.openSuccess;
}
