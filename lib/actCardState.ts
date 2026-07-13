// 정규(그리고 변동) 액트 카드의 "상태 판정" 단일 SoT — browser-safe, DB 접근 없음.
//
// 활동 관리(주차 내역 > 활동 관리) 액트 체크 카드의 색상/표시는 아래 5상태로 결정된다.
// 판정은 "포맷된 문자열"이 아니라 원본 timestamp(epoch ms) 로만 한다. epoch ms 비교는
// 타임존과 무관하므로 서버/클라이언트가 서로 다른 시간대 판정을 하지 않는다.
//
//   inactive           = 액트는 존재하나 이번 주 가동 대상 아님 + 체크 신청 기록 없음      → 회색
//   pending            = 가동 대상 + 미신청 + now ≤ 필요 시점                              → 노랑
//   overdue            = 가동 대상 + 미신청 + now > 필요 시점                              → 빨강
//   completed-on-time  = 체크 신청 기록 있음 + 실제 신청 시점 ≤ 필요 시점                   → 초록
//   completed-late     = 체크 신청 기록 있음 + 실제 신청 시점 > 필요 시점                   → 파랑
//
// 우선순위: 체크 신청 기록이 있으면 가동 여부·현재 시각보다 "완료 상태"를 우선한다.
//
// 경계값:
//   · actualCheckedAt === requiredCheckedAt → 정상 완료(completed-on-time, 초록)
//   · now            === requiredCheckedAt → 아직 지각 아님(pending, 노랑)

export type ActCardState =
  | "inactive"
  | "pending"
  | "overdue"
  | "completed-on-time"
  | "completed-late";

export type ActCardStateInput = {
  // 이번 주 가동(오픈 확인 + 라인급 체크) 대상인가.
  isActive: boolean;
  // 필요 시점(체크 신청 마감) — epoch ms. 미상이면 null(→ overdue 판정 불가).
  requiredCheckedAtMs: number | null;
  // 체크 신청 기록 — 없으면 null. actualCheckedAtMs = 실제 신청 시점(epoch ms, 미상 null).
  check: { actualCheckedAtMs: number | null } | null;
  // 판정 기준 현재 시각 — epoch ms(서버에서 주입).
  nowMs: number;
};

// 스펙 우선순위 그대로:
//   if (checkRecord) return actual <= required ? on-time : late;
//   if (!isActive)   return inactive;
//   return now > required ? overdue : pending;
export function resolveActCardState(input: ActCardStateInput): ActCardState {
  const { isActive, requiredCheckedAtMs, check, nowMs } = input;

  // 1) 체크 신청 기록이 있으면 완료 상태를 최우선(가동 여부·현재 시각 무관).
  if (check) {
    if (requiredCheckedAtMs == null || check.actualCheckedAtMs == null) return "completed-on-time"; // 필요 시점 미상 → 지각 아님
    return check.actualCheckedAtMs <= requiredCheckedAtMs ? "completed-on-time" : "completed-late";
  }

  // 2) 미신청 + 비가동 → 회색.
  if (!isActive) return "inactive";

  // 3) 미신청 + 가동 → 필요 시점 초과 여부로 overdue/pending.
  if (requiredCheckedAtMs == null) return "pending"; // 필요 시점 미상 → 지각 판정 불가(대기)
  return nowMs > requiredCheckedAtMs ? "overdue" : "pending";
}

// data-act-active: inactive 만 "0", 나머지(가동/완료) 는 "1". (스펙 권장 상태값)
export function actCardActiveAttr(state: ActCardState): "0" | "1" {
  return state === "inactive" ? "0" : "1";
}

// 완료(체크 신청 기록 존재) 상태인가 — 2번째 줄(실제 신청 시점·실행자·✓) 표시 여부.
export function isCompletedCardState(state: ActCardState): boolean {
  return state === "completed-on-time" || state === "completed-late";
}
