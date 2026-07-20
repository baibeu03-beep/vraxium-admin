import {
  enhancementStatusTone,
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
//   유일한 "변환"은 행 범위(①) 하나뿐이다 — 실린 행의 결과·라벨·톤은 admin 값을 그대로 옮긴다(②).
//
//   ① 행 범위: 클럽 오픈 라인만(clubOpen === true). 미오픈 master/카탈로그 행은 제외한다.
//      → rows.length === clubOpenCount 불변식 성립. (관리자 표는 미오픈 카탈로그 행도 함께
//        보여주지만, 크루 표는 "이번 주 클럽이 오픈한 라인"만 다룬다.)
//      ⚠ 이 필터로 인해 **요약의 "해당 없음"만** admin 과 다를 수 있다 — admin 은 미오픈 행을
//        not_applicable 로 세는 반면 크루는 그 행 자체를 싣지 않는다(실측: admin 6 / 크루 0).
//        행 범위 축의 의도된 차이이며, **실려 있는 행의 결과값은 admin 과 100% 동일**하다.
//
//   ② 결과/라벨/톤: admin enhancementStatus · enhancementLabel 을 **그대로** 옮긴다(재판정 금지).
//      ⚠ 2026-07-17 수정 — 이전 버전은 lineTargetId == null 이면 admin 이 fail 로 판정한 행까지
//        "해당 없음"으로 재분류했다. admin 표(CrewWeekLineHistory)는 enhancementStatus 만 보고
//        그리므로 같은 행이 admin=강화 실패 / 크루=해당 없음 으로 갈렸다
//        (실측: 정보 "인포데스크", reason=target_missing_required, ltid=null).
//        배정 여부는 결과의 입력이 아니라 **admin 판정이 이미 반영한 내부 근거**다
//        (computeCluster4Enhancement: !hasTarget && expectedWhenMissing → fail). 여기서 다시 보지 않는다.
//      ⚠ 미제출(submissionStatus)·포인트 0·평점 없음도 결과 재분류 근거가 **아니다**. 정보/경험은
//        미기입이어도 마감 후 성공 처리될 수 있다(실측: "위즈덤" submissionStatus=not_submitted
//        이지만 admin=success → 크루도 success). submissionStatus 와 강화 결과를 혼동하지 말 것.
//
// 불변식(전부 이 함수 안에서 by construction 성립 — 호출부 보정 금지):
//   clubOpenCount = rows.length = success + failure + notApplicable + pending
//   crewOpenCount = success + failure + pending        (확정 주차엔 pending=0 → = success + failure)
//     = admin 이 이 크루에게 실제 판정을 내린 행. 비배정이어도 admin 이 fail 로 판정했으면 포함된다
//       (배정 여부로 세지 않는다 — ② 참조).
//   notApplicableCount = clubOpenCount − crewOpenCount
//     = 클럽 오픈 행 중 admin enhancementStatus 가 not_applicable 인 행(파생값 — 재판정 아님).
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
//   v3 (2026-07-17): result 가 admin enhancementStatus 와 완전 일치(lineTargetId 재분류 제거).
//     shape 불변·값 변경 — 같은 행이 not_applicable → failure 로 바뀔 수 있다. weekly-cards snapshot 에
//     실리지 않는 lazy endpoint 전용 DTO 라 저장된 캐시가 없어 **백필/재계산 불필요**(요청마다 live 계산).
//     프론트 캐시는 (userId, weekId) 메모리 캐시뿐이라 새로고침이면 즉시 수렴한다.
//   v4 (2026-07-20): 평점 0점 강화 실패(experience·result=failure·rating=0) 행의 세부 데이터
//     (lineName/rating/kind/estimatedDurationMinutes)를 서버 DTO 단계에서 마스킹. shape 불변·값 변경
//     (해당 행의 세부 필드가 빈값/null). 결과 상태(강화 실패)·요약 합계·행 개수는 불변. lazy endpoint
//     (저장 캐시 없음) 이라 백필 불필요 — 새 요청부터 즉시 적용.
export const CREW_LINE_ENHANCEMENT_DTO_VERSION = 4;

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

// admin enhancementStatus → 크루 result 축. **순수 개명(rename)이며 판정이 아니다** —
//   admin 의 "fail" 을 크루 계약 이름 "failure" 로 부르는 것 외의 의미 변화가 없다.
//   Record 로 두어 Cluster4EnhancementStatus 가 늘어나면 컴파일이 깨지게 한다(조용한 not_applicable 폴백 금지).
const ENHANCEMENT_STATUS_TO_RESULT: Record<
  Cluster4EnhancementStatus,
  CrewLineEnhancementResult
> = {
  success: "success",
  fail: "failure",
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

// 행 결과 = admin enhancementStatus 개명. 판정·분기 없음(요구: 크루는 admin 값을 재해석하지 않는다).
//   ⚠ lineTargetId(배정 여부)·submissionStatus(제출 여부)·포인트·평점을 보지 말 것 — 전부 admin 이
//     이미 판정에 반영한 입력이다. 여기서 다시 보면 admin=강화 실패 행이 크루=해당 없음 으로 갈린다.
export function resolveCrewRowResult(
  row: Pick<CrewWeekLineDetailRow, "enhancementStatus">,
): CrewLineEnhancementResult {
  return ENHANCEMENT_STATUS_TO_RESULT[row.enhancementStatus];
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
    // ⑤ 평점 0점 강화 실패 마스킹 — 실제 평가가 완료되어(admin enhancementStatus="fail" → result="failure")
    //   최종 평점이 0점인 실무 경험 행은 "결과(강화 실패)"만 노출하고, 라인명/평점/유형(종류)/소요 시간 등
    //   실무 경험 세부 데이터는 **서버 DTO 단계에서 제거**한다(클라이언트 화면 숨김이 아님).
    //   ⚠ 판정은 하지 않는다 — result 는 admin SoT 값 그대로다. 마스킹은 표시 필드 제거뿐이며
    //     미평가(result="pending")·검수 미완료는 status≠fail 이라 여기 해당 없음(기존 상태 정책 유지).
    //     평점 1점 이상 실패는 실제 평점이 있으므로 마스킹하지 않는다(요구: 최종 평점 0점만).
    const maskExperienceFail =
      row.partType === "experience" && result === "failure" && row.rating === 0;
    return {
      // partType + 표시 순번 = 응답 내 안정·결정적. 내부 mutation 키 미노출.
      stableKey: `${row.partType}:${idx}`,
      result,
      // 라벨/톤 = admin 표(CrewWeekLineHistory)가 렌더하는 값 **그 자체**.
      //   enhancementLabel 은 이미 formatEnhancementStatusLabel(enhancementStatus) 결과라 재포맷하면
      //   presenter 가 이중화된다 — admin 이 만든 문자열을 그대로 옮겨 byte 동일을 보장한다.
      //   ⑤ 결과 라벨/톤은 유지("강화 실패")하고 세부 데이터만 마스킹한다.
      resultLabel: row.enhancementLabel,
      resultTone: enhancementStatusTone(row.enhancementStatus),
      lineName: maskExperienceFail ? "" : row.lineName,
      hub: HUB_BY_PART_TYPE[row.partType],
      hubLabel: row.hubLabel,
      kind: maskExperienceFail ? null : row.type,
      estimatedDurationMinutes: maskExperienceFail ? null : row.estimatedDurationMinutes,
      rating: maskExperienceFail ? null : resolveCrewRowRating(row),
      // 획득/가능 — admin SoT 값 그대로. 비배정(해당 없음) 행도 클럽 오픈이면 가능치가 있어 "0 / N".
      //   (요약 합계 불변식 보존을 위해 포인트는 마스킹 대상 아님 — 강화 실패는 이미 earned=0.)
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
