// Cluster3 성장 지표 (Process / Period / Point) — browser-safe types.
// DB 접근 없이 client components 에서 import 할 수 있다.
//
// 성장 상태 라벨/키·주차 결과 상태의 단일 출처는 shared/growth.contracts.ts 다.
// 아래는 기존 export 이름을 유지한 채 공통 contract 를 재참조한다(값 불변).

import type { WeekDbStatusKey, GrowthStatusKey } from "@/shared/growth.contracts";
import { WEEK_DB_STATUSES, GROWTH_STATUS_LABELS } from "@/shared/growth.contracts";

export type WeekStatus = WeekDbStatusKey;

export const WEEK_STATUSES: readonly WeekStatus[] = WEEK_DB_STATUSES;

// ─── 성장 상태 표시명 10종 ──────────────────────────────────────────
//
// (2026-06-07 개정) 자동 계산(auto) / 수동 오버라이드(override) 분리.
//   displayGrowthStatus = override(graduated/suspended/paused) ?? autoGrowthStatus.
//   자동 우선순위: seasonal_rest > weekly_rest > official_rest > onboarding
//                  > graduating(a>=29) > extra_growth(a>=조직임계) > active.
//   단일 출처: lib/growthCore.ts resolveGrowthStatusDetail.

// 공통 contract 재참조 (값/이름 불변). 단일 출처: shared/growth.contracts.ts
export const GROWTH_DISPLAY_LABELS = GROWTH_STATUS_LABELS;

export type GrowthDisplayKey = GrowthStatusKey;

// ─── Process (공개) ─────────────────────────────────────────────────
export type GrowthProcess = {
  growthStatus: string | null; // raw user_profiles.growth_status (legacy 값 포함)
  // 최종 표시 상태 = override ?? auto (고객/관리자/이력서 공통).
  growthStatusDisplay: string;
  growthDisplayKey: GrowthDisplayKey;
  // 자동 계산 상태 (관리자 화면 병기용).
  autoGrowthStatusKey: GrowthDisplayKey;
  autoGrowthStatusDisplay: string;
  // 수동 오버라이드 (graduated/suspended/paused 외 = null).
  manualOverrideStatus: string | null;
  manualOverrideReason: string | null; // 최근 변경 사유 (audit, 없으면 null)
  manualOverrideByName: string | null; // 최근 변경자 표시명 (audit, 없으면 null)
  manualOverrideAt: string | null; // 최근 변경일 ISO (audit, 없으면 null)
  // 오버라이드 ≠ 자동 계산 (관리자 경고용 raw 신호).
  overrideMismatch: boolean;
  activityStartedAt: string | null;
  activityStartedAtDisplay: string;
  activityEndedAt: string | null;
  activityEndedAtDisplay: string;
};

// ─── Period (공개) ──────────────────────────────────────────────────
export type GrowthPeriod = {
  a: number; // 성장(성공) 주차
  b: number; // 성장(실패) 주차
  c: number; // 휴식(개인) 주차
  d: number; // 휴식(공식) 주차
  e: number; // 성장 가능 주차 (a + b + c)
  h: number; // 물리적 주차 (a + b + c + d)
  f: number; // 성장 휴식 시즌 (시즌 전체 휴식 신청)
  g: number; // 성장(성공) 시즌 (f 가 아닌 시즌)
};

// ─── Point (공개) ───────────────────────────────────────────────────
export type GrowthPointLabeled = {
  points: number;          // j
  rawAdvantages: number;   // k0
  penalty: number;         // l (절대값)
  netAdvantages: number;   // k = k0 - l
  pointsLabel: string;
  advantagesLabel: string;
  penaltyLabel: string;
};

// ─── 주차 상세 (UI 주차 목록용) ─────────────────────────────────────
export type WeekStatusDetail = {
  year: number;
  weekNumber: number;
  weekStartDate: string;
  status: WeekStatus;
  isOfficialRestOverride: boolean;
  tooltip: string | null;
};

// ─── UI 툴팁 상수 ──────────────────────────────────────────────────
export const WEEK_TOOLTIPS = {
  officialRestOverride: "공식 휴식 주차이나 활동이 인정되었습니다",
  officialRest: "공식 휴식 주차입니다",
  personalRest: "개인 휴식 주차입니다",
} as const;

// ─── 공개 DTO (UI 용) ──────────────────────────────────────────────
export type GrowthIndicatorsDto = {
  userId: string;
  organizationSlug: string | null;
  process: GrowthProcess;
  period: GrowthPeriod;
  point: GrowthPointLabeled;
};

// ─── 내부 전용 (디버깅 · 테스트 · 관리자 검증) ─────────────────────
export type GrowthIndicatorsInternal = GrowthIndicatorsDto & {
  _debug: {
    graduationThreshold: number | null;
    graduationEligible: boolean;
    integrityOk: boolean;
    currentWeekStatus: string | null;
    officialRestOverrideCount: number;
    weekRowCount: number;
    seasonRowCount: number;
  };
};

// ─── 클럽 강화 품계 ────────────────────────────────────────────────

export const RANK_GRADES = [
  { min: 1,  max: 10,  label: "정승" },
  { min: 11, max: 20,  label: "정1품" },
  { min: 21, max: 30,  label: "정2품" },
  { min: 31, max: 40,  label: "정3품" },
  { min: 41, max: 50,  label: "정4품" },
  { min: 51, max: 60,  label: "정5품" },
  { min: 61, max: 70,  label: "정6품" },
  { min: 71, max: 80,  label: "정7품" },
  { min: 81, max: 90,  label: "정8품" },
  { min: 91, max: 100, label: "정9품" },
] as const;

export type RankGradeLabel = (typeof RANK_GRADES)[number]["label"];

export type WeeklyRankDetail = {
  year: number;
  weekNumber: number;
  weeklyScore: number;
  weeklyRank: number;
  totalParticipants: number;
  weeklyPercentile: number;
  isOnboarding: boolean;
};

export type ClubRankDto = {
  avgPercentile: number | null;
  avgPercentileDisplay: string;
  rankGrade: string | null;
  isFrozen: boolean;
  weeklyDetails: WeeklyRankDetail[];
};

export function resolveRankGrade(avgPercentile: number): RankGradeLabel {
  const pctCeil = Math.ceil(avgPercentile);
  const grade = RANK_GRADES.find((g) => pctCeil >= g.min && pctCeil <= g.max);
  return grade?.label ?? "정9품";
}

export function formatAvgPercentile(value: number): string {
  const ceiled = Math.ceil(value * 100) / 100;
  return ceiled.toFixed(2);
}

// ─── user_grade_stats 동기화용 매핑 ────────────────────────────────
//
// 프론트(Cluster3Content.tsx) 기준:
//   grade=1 → 정승, grade=2 → 정 1품, ... grade=10 → 정 9품
//   grade_label 형식: "정승" 또는 "정 N품" (공백 포함)

export const GRADE_NUMBER_MAP: Record<RankGradeLabel, number> = {
  "정승": 1,
  "정1품": 2,
  "정2품": 3,
  "정3품": 4,
  "정4품": 5,
  "정5품": 6,
  "정6품": 7,
  "정7품": 8,
  "정8품": 9,
  "정9품": 10,
} as const;

export const GRADE_LABEL_MAP: Record<RankGradeLabel, string> = {
  "정승": "정승",
  "정1품": "정 1품",
  "정2품": "정 2품",
  "정3품": "정 3품",
  "정4품": "정 4품",
  "정5품": "정 5품",
  "정6품": "정 6품",
  "정7품": "정 7품",
  "정8품": "정 8품",
  "정9품": "정 9품",
} as const;

export function toGradeNumber(rankGrade: RankGradeLabel): number {
  return GRADE_NUMBER_MAP[rankGrade];
}

export function toGradeLabel(rankGrade: RankGradeLabel): string {
  return GRADE_LABEL_MAP[rankGrade];
}
