// 실무 정보(info) 라인 — "개설 대상 크루 수정" 허용 정책 SoT (browser-safe).
//
// 정책(2026-06-24 변경): 고정 날짜 범위("25 겨울 W1 ~ 26 봄 W11") 폐기 →
//   "현재 시점 기준 이미 종료된 과거 주차"만 사후 수정 허용.
//     - 과거 주차(주차 종료일 < 오늘 KST)            = 수정 가능
//     - 현재 진행 중 주차 / 미래 주차                 = 수정 불가 (fail-closed)
//
// 서버(API 게이트=editInfoLineCrew)·클라이언트(버튼 노출=PracticalInfoWeekResults)가
// 동일 함수를 공유해 두 경로의 정책이 갈라지지 않는다(버튼만 보이고 저장이 막히는 불일치 방지).
// practical-info 전용. practical-experience 등 다른 허브에는 적용되지 않는다.
//
// '오늘'은 client 타임존과 무관하도록 epoch(절대시간) + KST(UTC+9) 오프셋으로 산출한다.
// → 클라이언트/서버 어디서 호출해도 동일한 KST 달력일로 판정(버튼==API 정합).
// date-only ISO 문자열은 사전식 비교가 곧 시간순 비교라 문자열 비교로 안전하게 판정한다.

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 정책 안내 문구 SoT (UI/에러 메시지 공용).
export const INFO_CREW_EDIT_POLICY_LABEL = "이미 종료된 과거 주차만 수정 가능";

// 오늘(KST) date-only ISO("YYYY-MM-DD"). nowMs 주입 가능(테스트 결정성).
export function kstTodayIso(nowMs?: number): string {
  const ms = typeof nowMs === "number" ? nowMs : Date.now();
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 주차가 '이미 종료된 과거 주차'인지(= 주차 종료일 < 오늘 KST).
//   - endDate 없으면 startDate 로 대체(단일 일자 보호).
//   - 날짜 형식 불량/없음 → false(fail-closed).
//   - 현재 진행 중(오늘이 주차 구간 내) / 미래 주차 → false.
export function isInfoCrewEditableWeek(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  nowMs?: number,
): boolean {
  const end = ((endDate ?? startDate) ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  return end < kstTodayIso(nowMs);
}
