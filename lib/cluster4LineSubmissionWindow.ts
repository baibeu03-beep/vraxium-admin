// Cluster4 라인 "2차 기입(라인 칸 제출)" 창(submission window) SoT — 주차 레벨 정책.
//
// 정책(2026-07-27 확정 — 실무 정보/경험/역량 3허브 통일):
//   라인의 submission_opens_at / submission_closes_at 는 **귀속 주차(week_id) 기준**이다.
//     - 라인 귀속 주차            = N주차 (cluster4_lines.week_id / line_targets.week_id)
//     - 실제 개설·사용자 기입 주차 = N+1주차
//     - submission_opens_at      = N+1주차 월요일 00:00 KST (= weekStart + 7일)
//     - submission_closes_at     = N+1주차 수요일 22:00 KST (= weekStart + 9일)
//   개설 시각(now)은 창 계산에 **일절 개입하지 않는다**. 따라서 N+1주차 수요일 22시가 지난 뒤
//   과거 주차를 뒤늦게 개설하면 마감이 이미 과거 → 대상자는 즉시 강화 성공으로 판정된다
//   (의도된 동작 — 소급 개설은 이미 기입 기간이 끝난 주차이므로).
//
// 계산은 lib/cluster4WeekPolicy.ts 의 submissionWindowForWeekStartIso 단일 함수에 위임한다.
//   같은 산식을 여기서 다시 구현하지 않는다 — weeks-options(개설 폼 표시 기간)·
//   lineOpeningWindowsData 도 같은 함수를 쓰므로 "화면에 보이는 기입 기간 == DB 저장값"이 성립한다.
//
// 왜 submission_closes_at 한 값이 SoT 인가:
//   이 값 하나가 (1)크루 수정 가능 여부(canEditCluster4Line)
//   (2)강화 deadlinePassed(모든 파생 지점: weekly-cards / admin lines / lineAvailability / resume)
//   (3)snapshot bake (4)payout reconcile(enhancementStatus 하류) 를 **동시에** 게이트한다.
//   따라서 개설 시 이 값만 주차 기준으로 stamp 하면 하류 코드 변경 없이 정책이 걸린다.
//   ⚠ 강화 판정 함수(computeCluster4Enhancement)는 이 변경과 무관하게 무수정이다 —
//     이 모듈은 "마감 시각을 언제로 찍느냐"만 정하고, 그 시각으로 무엇을 판정할지는 건드리지 않는다.
//
// 이 helper 를 쓰는 일반 개설 경로(3허브 6경로):
//   POST /api/admin/cluster4/{info,experience,competency}-lines
//   openApprovedApplications(역량 개설 대시보드) / openTeamOverall(경험 팀 총괄) / openExperienceDrafts(경험 초안)
//
// ⚠ 예외 — 이 helper 를 **쓰지 않는** 경로(의도적):
//   · adminCompetencyLineSelect / adminExperienceLineSelect 의 수동 "성공 전환" —
//     비대상 placeholder 를 대상자로 전환하며 의도적으로 과거 마감을 넣는다(즉시 success 수렴이 목적).
//   · PATCH /api/admin/cluster4/lines/[id] — 관리자가 폼에서 직접 입력한 창을 저장하는 수동 편집 lever.
//
// 수동 "2차 기입 마감"(force-close)도 같은 lever 를 쓴다: submission_closes_at 를 now 로 단축한다.
//   단 **조기 마감만** 허용(earlyCloseClosesAt = min(기존, now)) — 이미 마감된 라인은 값이 불변(멱등),
//   마감 시각을 뒤로 연장하는 동작은 금지한다.

import { submissionWindowForWeekStartIso } from "@/lib/cluster4WeekPolicy";

// 라인 개설 후 2차 기입(수정) 허용 기간 — 48시간.
//   ⚠ 2026-07-27 부로 **실무 정보/경험/역량 일반 개설 경로에서는 폐기**됐다(주차 기준으로 통일).
//     현재 남은 사용처는 실무 경력(career-lines POST) 뿐이다 — career 는 이번 통일 범위 밖.
export const LINE_SUBMISSION_WINDOW_MS = 48 * 60 * 60 * 1000;

export type LineOpenWindow = {
  submissionOpensAt: string; // ISO
  submissionClosesAt: string; // ISO
};

// ── 일반 개설 경로 공용 SoT ────────────────────────────────────────────────
// 귀속 주차 시작일(weeks.start_date, YYYY-MM-DD 월요일) → 2차 기입 창.
//   closes = weekStart + 9일 22:00 KST (= N+1주차 수요일). 개설 시각(now)과 무관하다.
//   실무 정보/경험/역량의 모든 일반 개설 경로가 이 함수 하나만 호출한다.
export function computeLineOpenWindowForWeekStart(
  weekStartIso: string,
): LineOpenWindow {
  return submissionWindowForWeekStartIso(weekStartIso);
}

// ── 개설 시점 기준(now + 48h) 창 — 실무 경력(career) 전용 잔존 경로 ──────────
//   ⚠ 실무 정보/경험/역량에서는 쓰지 않는다. 신규 호출부를 만들지 말 것
//     (3허브는 computeLineOpenWindowForWeekStart 사용).
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
