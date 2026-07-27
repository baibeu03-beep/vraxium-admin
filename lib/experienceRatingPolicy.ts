// 실무 경험 평점 정책 — 순수 상수 SoT (2026-07-27).
//
// "강화 시 포인트"(cluster4_line_point_configs 고정 설정값)와 "평점"
// (cluster4_experience_line_evaluations.rating 실제 평가값)은 **서로 다른 개념**이다.
// 평점은 강화 시 포인트를 대체하거나 환산하지 않고, 독립적으로 **추가** 적립된다.
//
// 이 파일은 "어느 카테고리가 어느 계산에 들어가는가"만 정의한다. 계산 자체는
//   · 조직 공통 주차 기준값 → lib/weekRecognitionCount.ts (기준 평점 4/7 · 실제 평점 미사용)
//   · 개인 Point A 적립     → lib/processPointAccrual.ts  (실제 평점 그대로 가산)
// 두 곳이 각자 담당하며, 카테고리 집합만 여기서 공유해 별칭/누락 드리프트를 막는다.
//
// ⚠ 식별자 축: 여기 값은 **포인트 config_key**(derive/analysis/research/management/expansion) 다.
//   cluster4_experience_line_masters.experience_category 는 별칭 축
//   (derivation/analysis/evaluation/management/extension)이며, 변환 SoT 는
//   lib/processPointAccrual.ts 의 EXP_CATEGORY_TO_CONFIG_KEY 하나뿐이다.

import type { ExperienceLineType } from "@/lib/adminTeamPartsInfoWeekDetailData";

// 조직 공통 기준(주차별 인정 Point A · minimalA/diligentB/N)에 들어가는 카테고리.
//   관리 = 특정 인원만 수행 → 조직 전체가 충족해야 하는 기준에서 제외.
//   확장 = 이번 정책 대상 아님 → 제외.
export const EXPERIENCE_WEEK_CRITERION_TYPES: ExperienceLineType[] = [
  "derive",
  "analysis",
  "research",
];

// 개인 Point A 로 **실제 평점**이 추가 적립되는 카테고리.
//   관리는 실제 수행자에게 지급하므로 포함한다(조직 기준에서 빠지는 것과 별개).
//   확장은 이번 정책 대상이 아니므로 제외.
export const EXPERIENCE_RATING_AWARD_TYPES: ExperienceLineType[] = [
  "derive",
  "analysis",
  "research",
  "management",
];

// 평점 Point A 지급 하한 — 강화 성공 판정과 동일 경계(rating <= 3 = 강화 실패 = 미지급).
//   SoT 는 lib/cluster4Enhancement.ts EXPERIENCE_RATING_FAIL_THRESHOLD(=3) 이며 이 값은 그 +1.
export const EXPERIENCE_RATING_AWARD_MIN_RATING = 4;

export function isWeekCriterionExperienceType(type: string): boolean {
  return (EXPERIENCE_WEEK_CRITERION_TYPES as string[]).includes(type);
}

export function isRatingAwardExperienceType(configKey: string): boolean {
  return (EXPERIENCE_RATING_AWARD_TYPES as string[]).includes(configKey);
}
