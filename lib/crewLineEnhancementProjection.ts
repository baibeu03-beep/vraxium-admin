import {
  enhancementStatusTone,
  formatEnhancementStatusLabel,
  type EnhancementBadgeTone,
} from "@/lib/cluster4EnhancementLabels";
import type {
  CrewWeekLineDetailRow,
  CrewWeekLineSummaryDto,
} from "@/lib/adminCrewWeekLineSummary";
import type { LineDurationMinutes } from "@/lib/adminLineRegistrationsTypes";
import type {
  Cluster4EnhancementStatus,
  Cluster4LinePartType,
} from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 크루(고객앱) "라인 강화 내역" read-only projection — 순수 함수(조회 전용).
//
// 입력 = getCrewWeekLineSummary()(관리자 라인 강화 내역 SoT) 결과 **그대로**.
//   이 모듈은 판정/집계를 다시 하지 않는다 — 강화 결과(enhancementStatus)·평점·유형·허브·
//   포인트(earned/possible)는 전부 admin SoT 값을 옮겨 담기만 한다(재계산 금지).
//   유일한 "변환"은 아래 2가지이며 둘 다 요구사항에 명시된 표시 정책이다:
//
//   ① 행 범위: 클럽 오픈 라인만(clubOpen === true). 미오픈 master/카탈로그 행은 제외한다.
//      → rows.length === clubOpenCount 불변식 성립. (관리자 표는 미오픈 정보 8행도 함께
//        보여주지만, 크루 표는 "이번 주 클럽이 오픈한 라인"만 다룬다 — 요구 §6.)
//
//   ② 결과 분할: 크루 배정 여부(lineTargetId)로 해당 없음을 분리한다 — 요구 §4.
//        · lineTargetId != null (배정)      → admin enhancementStatus 그대로 매핑.
//        · lineTargetId == null (비배정)    → "해당 없음"(not_applicable).
//      ⚠ admin 화면은 이 "클럽 오픈 + 비배정" 행을 강화 실패(fail)로 표기한다
//        (computeCluster4Enhancement: !hasTarget && expectedWhenMissing → fail).
//        크루 표는 요구 정의(해당 없음 = 클럽 오픈 − 크루 오픈)를 따르므로 같은 행이
//        admin=강화 실패 / 크루=해당 없음 으로 보인다. 원천 데이터는 동일하며(같은
//        getCrewWeekLineSummary 호출) 표시 분할만 다르다 — 의도된 문서화 차이.
//
// 불변식(전부 이 함수 안에서 by construction 성립 — 호출부 보정 금지):
//   clubOpenCount = rows.length = success + failure + notApplicable + pending
//   crewOpenCount = success + failure + pending        (확정 주차엔 pending=0 → = success + failure)
//   notApplicableCount = clubOpenCount − crewOpenCount
//   enhancementRate = round(success / crewOpen × 100), 분모 0 → 0 (100% 처리 금지)
//   summary.point{A,B,C}.{earned,available} = Σ rows.point{A,B,C}.{earned,available}
//
// 관리자 전용 필드(2차 기입 override/편집권/mutation 키/제출 원문)는 절대 싣지 않는다.
//
// ③ 평점 원천 선택(v2, 2026-07-17) — 허브별로 "어느 기존 SoT 를 표시할지"만 고른다. 재계산 아님:
//      · experience → row.rating            (user_activity_details 평점, 0~10)
//      · career     → row.careerGradePoints (cluster4_career_line_evaluations.grade_points,
//                                            S=10/A=8/B=6/C=4/D=2 — 경험과 동일한 0~10 축)
//      · info/competency → null("-")        (원천이 NULL 로 강제됨 — userActivityDetailsData 참조)
//    ⚠ 이 선택을 admin 표(CrewWeekLineDetailRow.rating)에 밀어넣지 않는다 — admin "평점" 열은
//      경험 전용 표시를 유지해야 하므로, 허브별 원천 선택은 이 크루 projection 에서만 한다.
// ─────────────────────────────────────────────────────────────────────

// DTO 버전 — 크루 응답 계약이 바뀌면 bump(프론트 호환 분기용).
//   v2 (2026-07-17): estimatedDurationMinutes · pointC · career 평점(careerGradePoints) 추가 — additive.
export const CREW_LINE_ENHANCEMENT_DTO_VERSION = 2;

export type CrewLineEnhancementResult =
  | "success"
  | "failure"
  | "not_applicable"
  | "pending"; // 미확정(집계 전) 주차 — 확정 주차엔 나오지 않는다

export type CrewLineEnhancementHub =
  | "practical_info"
  | "practical_experience"
  | "practical_competency"
  | "practical_career";

export type CrewLineGrowthRequirement = "required" | "optional";

export type CrewLinePointPair = {
  earned: number;
  available: number;
};

export type CrewWeekLineEnhancementRowDto = {
  // 렌더/정렬용 안정키. mutation 식별자(lineId/lineTargetId)를 노출하지 않는다.
  stableKey: string;
  result: CrewLineEnhancementResult;
  resultLabel: string; // 강화 성공 / 강화 실패 / 해당 없음 / 집계 전 (admin 라벨 SoT 재사용)
  resultTone: EnhancementBadgeTone; // success / danger / neutral (admin 톤 SoT 재사용)
  lineName: string;
  hub: CrewLineEnhancementHub;
  hubLabel: string; // "실무 정보" 등 — admin formatProcessHubLabel 결과 그대로
  kind: string | null; // 종류/유형(도출/분석/원리/일반 …) — admin resolveLineTypeLabel SoT. 미해석=null → UI "-"
  // 예상 소요 시간(분) — line_registrations.estimated_duration_minutes SoT. null=미설정 → UI "-".
  //   ⚠ 분 정수만 싣는다. "0.5 h" 같은 표시 문자열은 프론트 formatLineDuration 이 만든다(포맷 이중화 금지).
  estimatedDurationMinutes: LineDurationMinutes | null;
  // 평점(0~10) — experience=활동 평점 · career=등급 환산 점수 · info/competency=null("-").
  //   값 없음=null → UI "-". 0 과 null 을 혼동하지 않는다(0=명시적 0점, null=원천 없음).
  rating: number | null;
  pointA: CrewLinePointPair;
  pointB: CrewLinePointPair;
  pointC: CrewLinePointPair; // 번개 — 원장 point_penalty / config point_c(현재 원천상 0/0)
  growthRequirement: CrewLineGrowthRequirement;
};

export type CrewWeekLineEnhancementDetailDto = {
  version: number;
  userId: string;
  weekId: string;
  organizationSlug: string | null;
  // 결과 확정 여부(미확정 = 집계 전 → pending 행이 남을 수 있음). admin SoT 그대로.
  confirmed: boolean;
  // 휴식(개인/공식) 주차 — admin 정책상 라인 목록을 만들지 않는다(rows=[] , 전 지표 0).
  isRestWeek: boolean;
  summary: {
    enhancementRate: number;
    clubOpenCount: number;
    crewOpenCount: number;
    successCount: number;
    failureCount: number;
    notApplicableCount: number;
    pendingCount: number;
    pointA: CrewLinePointPair;
    pointB: CrewLinePointPair;
    pointC: CrewLinePointPair;
  };
  rows: CrewWeekLineEnhancementRowDto[];
};

const HUB_BY_PART_TYPE: Record<Cluster4LinePartType, CrewLineEnhancementHub> = {
  information: "practical_info",
  experience: "practical_experience",
  competency: "practical_competency",
  career: "practical_career",
};

// 크루 result → admin enhancementStatus (라벨/톤 SoT 재사용 목적의 역매핑).
const RESULT_TO_ENHANCEMENT_STATUS: Record<
  CrewLineEnhancementResult,
  Cluster4EnhancementStatus
> = {
  success: "success",
  failure: "fail",
  not_applicable: "not_applicable",
  pending: "pending",
};

// 주차 성장 조건 — 실무 경험만 필수, 나머지 허브는 자율(요구 §5). 공통 helper.
//   ⚠ partType(허브 판정 결과)만 본다 — 라인명 문자열로 판정하지 않는다.
export function resolveGrowthRequirement(
  partType: Cluster4LinePartType,
): CrewLineGrowthRequirement {
  return partType === "experience" ? "required" : "optional";
}

// 표시 평점 — 허브별 **기존 SoT 선택**(재계산·환산 아님. 두 값 모두 admin 이 이미 계산해 둔 0~10 축).
//   experience → rating(활동 평점) · career → careerGradePoints(등급 환산 점수) · 그 외 → null("-").
//   원천이 없으면 임의 숫자를 만들지 않고 null 을 그대로 흘린다.
export function resolveCrewRowRating(
  row: Pick<CrewWeekLineDetailRow, "partType" | "rating" | "careerGradePoints">,
): number | null {
  // ⚠ 반드시 null 로 정규화한다 — undefined 를 흘리면 JSON.stringify 가 키를 **통째로 삭제**해
  //   응답에서 rating 필드가 사라진다(계약: number | null. 프론트 "-" 폴백도 못 탄다).
  switch (row.partType) {
    case "experience":
      return row.rating ?? null;
    case "career":
      return row.careerGradePoints ?? null;
    case "information":
    case "competency":
      return null; // 원천에서 NULL 강제(userActivityDetailsData) — 표시도 "-"
  }
}

// 행 결과 — 배정(lineTargetId) 여부로 해당 없음을 분리한 뒤, 배정 행만 admin 판정을 매핑한다.
//   ⚠ 여기서 성공/실패를 새로 판정하지 않는다(admin enhancementStatus 를 옮기기만 함).
export function resolveCrewRowResult(
  row: Pick<CrewWeekLineDetailRow, "lineTargetId" | "enhancementStatus">,
): CrewLineEnhancementResult {
  if (row.lineTargetId == null) return "not_applicable"; // 클럽 오픈 + 이 크루 비대상
  switch (row.enhancementStatus) {
    case "success":
      return "success";
    case "fail":
      return "failure";
    case "pending":
      return "pending";
    case "not_applicable":
      return "not_applicable";
    default:
      return "not_applicable";
  }
}

export function projectCrewLineEnhancement(args: {
  userId: string;
  weekId: string;
  summary: CrewWeekLineSummaryDto;
}): CrewWeekLineEnhancementDetailDto {
  const { userId, weekId, summary } = args;

  // ① 클럽 오픈 라인만. 미오픈 master/카탈로그 행 제외 → rows.length === clubOpenCount.
  //    admin lineDetails 의 결정적 순서(정보→경험→역량→경력)를 그대로 보존한다.
  const openRows = summary.lineDetails.filter((row) => row.clubOpen);

  const rows: CrewWeekLineEnhancementRowDto[] = openRows.map((row, idx) => {
    const result = resolveCrewRowResult(row);
    const status = RESULT_TO_ENHANCEMENT_STATUS[result];
    return {
      // partType + 표시 순번 = 응답 내 안정·결정적. 내부 mutation 키 미노출.
      stableKey: `${row.partType}:${idx}`,
      result,
      resultLabel: formatEnhancementStatusLabel(status),
      resultTone: enhancementStatusTone(status),
      lineName: row.lineName,
      hub: HUB_BY_PART_TYPE[row.partType],
      hubLabel: row.hubLabel,
      kind: row.type,
      estimatedDurationMinutes: row.estimatedDurationMinutes,
      rating: resolveCrewRowRating(row),
      // 획득/가능 — admin SoT 값 그대로. 비배정(해당 없음) 행도 클럽 오픈이면 가능치가 있어 "0 / N".
      pointA: { earned: row.earnedA, available: row.possibleA },
      pointB: { earned: row.earnedB, available: row.possibleB },
      pointC: { earned: row.earnedC, available: row.possibleC },
      growthRequirement: resolveGrowthRequirement(row.partType),
    };
  });

  const countOf = (r: CrewLineEnhancementResult) =>
    rows.filter((row) => row.result === r).length;

  const successCount = countOf("success");
  const failureCount = countOf("failure");
  const pendingCount = countOf("pending");
  const notApplicableCount = countOf("not_applicable");

  const clubOpenCount = rows.length;
  // 크루 오픈 = 이 크루가 실제 수행 대상이었던 라인(= 해당 없음이 아닌 행).
  //   notApplicableCount = clubOpenCount − crewOpenCount 가 항상 성립한다.
  const crewOpenCount = successCount + failureCount + pendingCount;

  // 강화율 = 성공 / 크루 오픈 × 100. 분모 0 → 0%(임의 100% 처리 금지 — 요구 §4).
  const enhancementRate =
    crewOpenCount > 0 ? Math.round((successCount / crewOpenCount) * 100) : 0;

  const sum = (pick: (row: CrewWeekLineEnhancementRowDto) => number) =>
    rows.reduce((n, row) => n + (pick(row) || 0), 0);

  return {
    version: CREW_LINE_ENHANCEMENT_DTO_VERSION,
    userId,
    weekId,
    organizationSlug: summary.organizationSlug,
    confirmed: summary.confirmed,
    isRestWeek: summary.isRestWeek,
    summary: {
      enhancementRate,
      clubOpenCount,
      crewOpenCount,
      successCount,
      failureCount,
      notApplicableCount,
      pendingCount,
      // 요약 포인트 = 표시 중인 행의 합(Σ rows). 획득 역산/성공 행만 합산 금지 —
      //   available 은 라인 오픈 당시 설정된 최대 가능치(admin config SoT)의 합이다.
      pointA: { earned: sum((r) => r.pointA.earned), available: sum((r) => r.pointA.available) },
      pointB: { earned: sum((r) => r.pointB.earned), available: sum((r) => r.pointB.available) },
      // C 도 A/B 와 **동일하게 Σ rows** — 요약이 표 합계와 항상 일치한다(값이 0 이어도 규칙 동일).
      pointC: { earned: sum((r) => r.pointC.earned), available: sum((r) => r.pointC.available) },
    },
    rows,
  };
}
