// 실무 경험 라인 개설 로그 — 표기 포맷(browser-safe, DB 무관). 컴포넌트/데이터레이어 공유.
// 기간/시간 포맷은 practicalInfoSection0Format 의 공용 함수를 재사용한다(중복 작성 회피).

export type ExperienceOpeningLogAction =
  | "apply" // 개설 신청 (파트장)
  | "apply_cancel" // 신청 취소 (파트장 — 개설 취소와 다른 이벤트)
  | "review" // 개설 검수(승인)
  | "reject" // 검수 반려
  | "review_cancel" // 검수 취소 — 검수 후 파트 신청 데이터가 실제로 바뀌어 검수가 무효화됨
  | "open" // 개설 완료
  | "cancel"; // 개설 취소(완료 이후) — 향후 기능

export const EXPERIENCE_OPENING_LOG_ACTION_LABEL: Record<
  ExperienceOpeningLogAction,
  string
> = {
  apply: "개설 신청",
  apply_cancel: "신청 취소",
  review: "개설 검수",
  reject: "검수 반려",
  review_cancel: "검수 취소",
  open: "개설 완료",
  cancel: "개설 취소",
};

// 행동 색(강조). 긍정 진행=green, 신청/검수 취소=amber(개설 취소와 구분), 부정(반려/개설취소)=red, 중간(신청/검수)=blue.
export function experienceOpeningLogActionClass(
  action: ExperienceOpeningLogAction,
): string {
  switch (action) {
    case "open":
      return "text-green-700";
    case "apply_cancel":
    case "review_cancel":
      return "text-amber-700";
    case "reject":
    case "cancel":
      return "text-red-700";
    default:
      return "text-blue-700";
  }
}

export function isExperienceOpeningLogAction(
  value: unknown,
): value is ExperienceOpeningLogAction {
  return (
    typeof value === "string" &&
    value in EXPERIENCE_OPENING_LOG_ACTION_LABEL
  );
}
