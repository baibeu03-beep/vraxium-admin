// ─────────────────────────────────────────────────────────────────────
// Growth Core 공통 계약 (browser-safe, 서버 전용 import 금지).
//
// 목적: cluster1 / cluster3 / cluster4 가 동일한 "성장 상태 / 주차 결과 /
//       성장 지표" 용어(타입·라벨·상수)를 단일 출처에서 참조하도록 한다.
//
// ⚠ 이 파일은 Growth Core 통합 1단계(용어 통일) 산출물이다.
//   계산 로직은 포함하지 않으며(타입/상수만), 기존 화면/계산 결과를 바꾸지 않는다.
//   값과 키 순서는 기존 cluster3GrowthTypes / cluster4WeeklyGrowthTypes 와
//   바이트 단위로 동일해야 한다(회귀 방지).
// ─────────────────────────────────────────────────────────────────────

// ─── 주차 결과 6종 ──────────────────────────────────────────────────
// DB 저장값(user_week_statuses.status) 4종 + 런타임 파생 2종.

// DB에 저장되는 주차 결과 상태 (user_week_statuses.status)
export type WeekDbStatusKey = "success" | "fail" | "personal_rest" | "official_rest";

// 런타임 전용 상태 (현재 주차 / 집계 전 판별용)
export type WeekRuntimeStatusKey = "running" | "tallying";

// 통합 6종 상태
export type WeekResultStatusKey = WeekDbStatusKey | WeekRuntimeStatusKey;

// DB 저장값 순회용 배열 (기존 cluster3GrowthTypes.WEEK_STATUSES 와 동일 값/순서).
export const WEEK_DB_STATUSES: readonly WeekDbStatusKey[] = [
  "success",
  "fail",
  "personal_rest",
  "official_rest",
];

// 주차 결과 라벨 (기존 cluster4WeeklyGrowthTypes.WEEK_STATUS_LABEL 과 동일).
export const WEEK_RESULT_LABELS: Record<WeekResultStatusKey, string> = {
  running: "성장(진행 중)",
  tallying: "성장(집계 중)",
  success: "성장(성공)",
  fail: "성장(실패)",
  personal_rest: "휴식(개인)",
  official_rest: "휴식(공식)",
};

// ─── 성장 상태 10종 ─────────────────────────────────────────────────
//
// DB growth_status 와 1:1 이 아님. 일부는 계산 상태(DB + Period 조합)로 도출.
//
// 우선순위 (높은 번호가 우선) — GROWTH_STATUS_PRIORITY 와 동일.
// (2026-06-07 개정: graduating 은 수동값 신뢰 폐기 → a>=29 자동 계산.
//  운영 override 는 graduated/suspended/paused 3종만.)
//   10. graduated      → "성장 완료(졸업)"   (운영 override)
//    9. suspended      → "성장 중단"         (운영 override)
//    8. paused         → "성장 유보"         (운영 override)
//    7. seasonal_rest  → "시즌 휴식 중"      (휴식 신청 기록과 동기)
//    6. weekly_rest    → "휴식(개인) 중"     (휴식 신청 기록과 동기)
//    5. official_rest  → "휴식(공식) 중"     (현재 주차 파생)
//    4. onboarding     → "클럽 온보딩 중"   (h <= 1)
//    3. graduating     → "졸업 절차 중"     (a >= 29 && 미졸업 — 자동 계산)
//    2. extra_growth   → "추가 성장 중"     (a >= 조직 졸업기준 && a < 29)
//    1. active         → "성장 중"          (default)

// 성장 상태 라벨 (기존 cluster3GrowthTypes.GROWTH_DISPLAY_LABELS 와 동일 값/순서).
export const GROWTH_STATUS_LABELS = {
  graduated: "성장 완료(졸업)",
  suspended: "성장 중단",
  paused: "성장 유보",
  graduating: "졸업 절차 중",
  seasonal_rest: "시즌 휴식 중",
  weekly_rest: "휴식(개인) 중",
  official_rest: "휴식(공식) 중",
  onboarding: "클럽 온보딩 중",
  extra_growth: "추가 성장 중",
  active: "성장 중",
} as const;

export type GrowthStatusKey = keyof typeof GROWTH_STATUS_LABELS;

// DB 에 저장 가능한 growth_status 값 7종 (계산 파생 onboarding/extra_growth/official_rest 제외).
//   user_profiles.growth_status 컬럼 CHECK 제약과 동일 집합 (legacy 행 호환용).
//   GrowthStatusKey(10, 표시용) ⊃ GROWTH_STATUSES(7, 저장용).
export const GROWTH_STATUSES = [
  "active",
  "weekly_rest",
  "seasonal_rest",
  "paused",
  "suspended",
  "graduating",
  "graduated",
] as const satisfies readonly GrowthStatusKey[];

export type GrowthStatusValue = (typeof GROWTH_STATUSES)[number];

export function isGrowthStatusValue(
  value: string | null,
): value is GrowthStatusValue {
  return Boolean(value && (GROWTH_STATUSES as readonly string[]).includes(value));
}

// ─── 수동 오버라이드 3종 (2026-06-07 자동 계산 전환 후 신규 쓰기 허용 집합) ──
//
// growth_status 는 "관리자 수동 오버라이드" 저장 컬럼으로 재해석한다:
//   - 오버라이드로 인정되는 값 = 아래 3종뿐 (운영 이벤트 — 자동 도출 불가).
//   - 그 외 legacy 값(active/weekly_rest/seasonal_rest/graduating)은 표시 계산에서
//     무시되고 자동 계산(autoGrowthStatus)이 사용된다.
//   - 관리자 신규 쓰기(members PATCH)도 3종 + NULL(해제)만 허용한다.
export const MANUAL_OVERRIDE_STATUSES = [
  "graduated",
  "suspended",
  "paused",
] as const satisfies readonly GrowthStatusKey[];

export type ManualOverrideStatus = (typeof MANUAL_OVERRIDE_STATUSES)[number];

export function isManualOverrideStatus(
  value: string | null,
): value is ManualOverrideStatus {
  return Boolean(
    value && (MANUAL_OVERRIDE_STATUSES as readonly string[]).includes(value),
  );
}

// 성장 상태 우선순위 (높을수록 우선). resolveDisplayKey 결정 순서의 명시적 표현.
// (이번 단계에서는 계산에 사용하지 않음 — 참조용 단일 출처)
// 2026-06-07 개정: graduating 이 자동 계산(a>=29)으로 전환되며 onboarding 아래로 이동.
export const GROWTH_STATUS_PRIORITY: Record<GrowthStatusKey, number> = {
  graduated: 10,
  suspended: 9,
  paused: 8,
  seasonal_rest: 7,
  weekly_rest: 6,
  official_rest: 5,
  onboarding: 4,
  graduating: 3,
  extra_growth: 2,
  active: 1,
};

// ─── 성장 지표 11종 ─────────────────────────────────────────────────
//
// 기존 cluster3GrowthTypes.GrowthPeriod 변수와의 대응(참조용, 계산 불변):
//   successWeeks=a · failWeeks=b · personalRestWeeks=c · officialRestWeeks=d
//   growableWeeks=e(a+b+c) · elapsedWeeks=h
//   successSeasons=g · restSeasons=f
//   startSeason / growableSeasons(=g+f) / endSeason 은 신규 시즌 지표(미구현).

export const GROWTH_METRIC_KEYS = [
  "successWeeks",
  "failWeeks",
  "personalRestWeeks",
  "officialRestWeeks",
  "growableWeeks",
  "elapsedWeeks",
  "startSeason",
  "growableSeasons",
  "successSeasons",
  "restSeasons",
  "endSeason",
] as const;

export type GrowthMetricKey = (typeof GROWTH_METRIC_KEYS)[number];

export const GROWTH_METRIC_LABELS: Record<GrowthMetricKey, string> = {
  successWeeks: "성장(성공)주차",
  failWeeks: "성장(실패)주차",
  personalRestWeeks: "휴식(개인)주차",
  officialRestWeeks: "휴식(공식)주차",
  growableWeeks: "성장 가능 주차",
  elapsedWeeks: "지나간 주차",
  startSeason: "성장 시작 시즌",
  growableSeasons: "성장 가능 시즌",
  successSeasons: "성장 성공 시즌",
  restSeasons: "성장 휴식 시즌",
  endSeason: "성장 종료 시즌",
};

// ─── cluster1 resume 뱃지 매핑 (준비만 — 아직 STATUS_MAP 교체 안 함) ──
//
// ⚠ code/label 리터럴은 lib/cluster1ResumeTypes.ts 의 ResumeStatusCode /
//   ResumeStatusLabel 과 반드시 일치해야 한다(향후 wiring 시 타입 호환).
//   isBadgeDimmed 는 기존 cluster1ResumeData.resolveResumeStatus 규칙
//   (complete 외 전부 dim) 을 그대로 따른다.

export type ResumeBadgeCode =
  | "running"
  | "complete"
  | "on_rest"
  | "recharging"
  | "next_challenge";

export type ResumeBadgeLabel =
  | "Running"
  | "Complete"
  | "On Rest"
  | "Recharging"
  | "Next Challenge";

export type ResumeBadgeSpec = {
  code: ResumeBadgeCode;
  label: ResumeBadgeLabel;
  isBadgeDimmed: boolean;
};

// 성장 상태 10종 → resume 뱃지 5종. (design-user-status-ssot-20260528.md §2-B 를
// Growth Core 10종 키로 확장한 것)
// 진행 중인 크루(Running): active / onboarding / extra_growth / graduating
// 졸업(Complete): graduated · 주차 휴식(On Rest): weekly_rest
// 시즌 휴식(Recharging): seasonal_rest / official_rest · 활동 중단(Next Challenge): paused / suspended
export const RESUME_BADGE_BY_GROWTH_STATUS: Record<GrowthStatusKey, ResumeBadgeSpec> = {
  graduated: { code: "complete", label: "Complete", isBadgeDimmed: false },
  active: { code: "running", label: "Running", isBadgeDimmed: true },
  onboarding: { code: "running", label: "Running", isBadgeDimmed: true },
  extra_growth: { code: "running", label: "Running", isBadgeDimmed: true },
  graduating: { code: "running", label: "Running", isBadgeDimmed: true },
  weekly_rest: { code: "on_rest", label: "On Rest", isBadgeDimmed: true },
  seasonal_rest: { code: "recharging", label: "Recharging", isBadgeDimmed: true },
  official_rest: { code: "recharging", label: "Recharging", isBadgeDimmed: true },
  paused: { code: "next_challenge", label: "Next Challenge", isBadgeDimmed: true },
  suspended: { code: "next_challenge", label: "Next Challenge", isBadgeDimmed: true },
};
