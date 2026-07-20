// Cluster4 라인 "2차 기입(라인 칸 제출)" 창(submission window) SoT — 개설 시점 기준 48시간 정책.
//
// 정책(2026-07-20 확정): 라인의 submission_opens_at / submission_closes_at 는 더 이상
//   주차 레벨(수 22:00 KST)이 아니라 **개설 시점 기준**이다.
//     - submission_opens_at  = 개설 시점(now)         → 대상자는 개설 즉시 강화 대기 + 수정 가능
//     - submission_closes_at = 개설 시점 + 48시간      → 48h 경과 시 수정 종료 + 강화 최종 판정
//   week_id(코호트/귀속 주차)는 그대로 유지하고, 창(window)만 주차 레벨에서 분리한다.
//
// 왜 이 한 값이 SoT 인가:
//   submission_closes_at 하나가 (1)크루 수정 가능 여부(canEditCluster4Line)
//   (2)강화 deadlinePassed(모든 파생 지점: weekly-cards / admin lines / lineAvailability / resume)
//   (3)snapshot bake (4)payout reconcile(enhancementStatus 하류) 를 **동시에** 게이트한다.
//   따라서 개설 시 이 값만 now+48h 로 stamp 하면 위 전부가 코드 변경 없이 48h 정책을 따른다.
//   info/competency/experience/career 4허브 공용 — 개설 라우트가 이 helper 로 창을 통일한다.
//
// 수동 "2차 기입 마감"(force-close)도 같은 lever 를 쓴다: submission_closes_at 를 now 로 단축한다.
//   단 **조기 마감만** 허용(earlyCloseClosesAt = min(기존, now)) — 이미 마감된 라인은 값이 불변(멱등),
//   마감 시각을 뒤로 연장하는 동작은 금지한다.

// 라인 개설 후 2차 기입(수정) 허용 기간 — 48시간. 4허브 공용 SoT.
export const LINE_SUBMISSION_WINDOW_MS = 48 * 60 * 60 * 1000;

export type LineOpenWindow = {
  submissionOpensAt: string; // ISO — 개설 시점(now)
  submissionClosesAt: string; // ISO — 개설 시점 + 48h
};

// 개설 시점 기준 창 산출. nowMs 는 개설 순간(기본 Date.now()).
export function computeLineOpenWindow(nowMs: number = Date.now()): LineOpenWindow {
  return {
    submissionOpensAt: new Date(nowMs).toISOString(),
    submissionClosesAt: new Date(nowMs + LINE_SUBMISSION_WINDOW_MS).toISOString(),
  };
}

// 수동/자동 조기 마감용 — 기존 마감 시각과 now 중 **이른 쪽**을 반환한다.
//   · now < 기존 마감      → now 로 단축(조기 마감)
//   · now >= 기존 마감      → 기존 값 유지(이미 마감 — 멱등, 연장 금지)
//   existingClosesAt 이 파싱 불가/부재면 now 로 마감(방어적).
export function earlyCloseClosesAt(
  existingClosesAt: string | null | undefined,
  nowMs: number = Date.now(),
): { closesAt: string; changed: boolean } {
  const nowIso = new Date(nowMs).toISOString();
  if (!existingClosesAt) {
    return { closesAt: nowIso, changed: true };
  }
  const existingMs = new Date(existingClosesAt).getTime();
  if (!Number.isFinite(existingMs) || nowMs < existingMs) {
    return { closesAt: nowIso, changed: true };
  }
  // 이미 마감(now >= 기존) — 값 불변.
  return { closesAt: existingClosesAt, changed: false };
}
