// Cluster3 stats-cards — canonical user-facing DTO (browser-safe).
//
// 이 파일은 DB 접근이 없어 client component / 프론트 레포 어디서든 import 가능하다.
// 단일 SoT: lib/cluster3GrowthData.ts 의 getGrowthIndicators() 실시간 계산값을
// lib/cluster3StatsCardsData.ts 가 본 DTO 형태로 매핑한다.
// (캐시 테이블 user_growth_stats / user_grade_stats 는 사용하지 않음)
//
// 원천 테이블 요약:
//   process.*        ← user_profiles (growth_status, activity_started_at, activity_ended_at)
//                      + user_week_statuses (현재 ISO 주차 status, 표시 라벨 도출용)
//   period weeks     ← user_week_statuses.status COUNT (success/fail/personal_rest/official_rest)
//   period seasons   ← user_season_statuses.status COUNT (rest/그 외)
//   points.*         ← user_cumulative_points (total_checks, total_raw_advantages, total_penalties)

import type { GrowthDisplayKey } from "@/lib/cluster3GrowthTypes";

// ─── 성장 진행 상태 (Process) ───────────────────────────────────────
export type Cluster3StatsProcess = {
  /** 표시 라벨 — 10종 우선순위로 도출 (예: "성장 중", "휴식(공식) 중"). 카드 본문 표기용. */
  growthStatus: string;
  /** 머신 키 — i18n / 스타일 분기용 (예: "active", "official_rest"). */
  growthStatusKey: GrowthDisplayKey;
  /** DB 원본 user_profiles.growth_status (nullable). 디버깅/정합 확인용. */
  growthStatusRaw: string | null;
  /** 성장 시작일 — ISO timestamp (user_profiles.activity_started_at). 미설정 시 null. */
  growthStartDate: string | null;
  /** 성장 시작일 표시용 — "YYYY-MM-DD" 또는 "—". */
  growthStartDateDisplay: string;
  /** 성장 종료일 — ISO timestamp (user_profiles.activity_ended_at). 진행 중이면 null. */
  growthEndDate: string | null;
  /** 성장 종료일 표시용 — "YYYY-MM-DD" 또는 "Be Cluving". */
  growthEndDateDisplay: string;
  /** activity_ended_at 이 null = 아직 성장 진행 중("Be Cluving"). */
  isBeCluving: boolean;
};

// ─── 성장 기간 집계 (Period) ────────────────────────────────────────
export type Cluster3StatsPeriod = {
  /** 성장 성공 주차 — user_week_statuses.status='success' COUNT. */
  successWeeks: number;
  /** 성장 성공(대기) 주차 — 원천 없음. 정책 정의 후 연결 필요. 현재 항상 null. */
  successWeeksPending: number | null;
  /** 성장 실패 주차 — status='fail' COUNT. */
  failWeeks: number;
  /** 개인 휴식 주차 — status='personal_rest' COUNT. */
  personalRestWeeks: number;
  /** 개인 휴식(대기) 주차 — 원천 없음. 정책 정의 후 연결 필요. 현재 항상 null. */
  personalRestWeeksPending: number | null;
  /** 공식 휴식 주차 — status='official_rest' COUNT. */
  officialRestWeeks: number;
  /** 성장 가능 주차 — successWeeks + failWeeks + personalRestWeeks (공식 휴식 제외). */
  growableWeeks: number;
  /** 물리적 주차 — 위 4종 전체 합 (참고용 추가 필드). */
  physicalWeeks: number;
  /** 개인 휴식 시즌 — user_season_statuses.status='rest' COUNT. */
  personalRestSeasons: number;
  /** 성장 성공 시즌 — user_season_statuses.status≠'rest' COUNT. */
  successSeasons: number;
};

// ─── 성장 점수 기록 (Point) ─────────────────────────────────────────
export type Cluster3StatsPoints = {
  /** 별(총합) — user_cumulative_points.total_checks (j). */
  totalStars: number;
  /** 방패(총합) — netAdvantages = total_raw_advantages - abs(total_penalties) (k = k0 - l). */
  totalShields: number;
  /** 번개(총합) — abs(user_cumulative_points.total_penalties) (l). */
  totalLightning: number;
  /** 조직별 라벨 — 별 (예: oranke="단감", encre="별"). */
  starsLabel: string;
  /** 조직별 라벨 — 방패 (예: oranke="인절미", encre="방패"). */
  shieldsLabel: string;
  /** 조직별 라벨 — 번개 (예: oranke="어흥", encre="번개"). */
  lightningLabel: string;
};

// ─── 최상위 DTO ─────────────────────────────────────────────────────
export type Cluster3StatsCards = {
  userId: string;
  organizationSlug: string | null;
  process: Cluster3StatsProcess;
  period: Cluster3StatsPeriod;
  points: Cluster3StatsPoints;
};
