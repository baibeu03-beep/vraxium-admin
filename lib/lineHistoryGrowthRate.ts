import type { Cluster4EnhancementStatus } from "@/shared/cluster4.contracts";

// 라인 강화 내역 전용 주차/허브 성장률 — **오픈된 라인 행 기준**(client-safe·DB 무관).
//   분모 = clubOpen 인 행 수(허브 집계·활동유형 중복제거 없음, 미오픈/해당없음 제외),
//   분자 = 그중 강화 성공(enhancementStatus === "success") 행. 오픈 0 이면 0%.
//   ⚠ 서버 모듈(adminCrewWeekLineSummary)과 클라이언트 컴포넌트(CrewWeekLineHistory)가 공유한다.
//     순수 함수라 별도 모듈로 분리해 클라이언트가 서버 전용 체인(supabaseAdmin 등)을 번들하지 않게 한다.
//   card.weeklyGrowthRate(허브 SoT breakdownFromLines)와 의미가 다르다 — 이 화면은 상단 요약과 하단
//     표(허브별 요약 헤더 포함)의 "오픈 라인 수"가 반드시 일치해야 하므로 표와 동일한 raw 행으로 재계산한다.
export function rawOpenLineGrowthRate(
  rows: readonly { clubOpen: boolean; enhancementStatus: Cluster4EnhancementStatus }[],
): number {
  const openCount = rows.filter((r) => r.clubOpen).length;
  if (openCount === 0) return 0;
  const successCount = rows.filter(
    (r) => r.clubOpen && r.enhancementStatus === "success",
  ).length;
  return Math.round((successCount / openCount) * 100);
}
