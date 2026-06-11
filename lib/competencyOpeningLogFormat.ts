// 실무 역량 라인 개설 로그 — 표기 포맷(browser-safe, DB 무관). 컴포넌트/데이터레이어 공유.
// 허브 전체 개설 완료/취소 2종만 존재한다(파트장 신청/검수 없음).

export type CompetencyOpeningLogAction = "open" | "cancel";

export const COMPETENCY_OPENING_LOG_ACTION_LABEL: Record<
  CompetencyOpeningLogAction,
  string
> = {
  open: "개설 완료",
  cancel: "개설 취소",
};

// 행동 색(강조). 개설 완료=green, 개설 취소=red.
export function competencyOpeningLogActionClass(
  action: CompetencyOpeningLogAction,
): string {
  return action === "open" ? "text-green-700" : "text-red-700";
}

export function isCompetencyOpeningLogAction(
  value: unknown,
): value is CompetencyOpeningLogAction {
  return value === "open" || value === "cancel";
}
