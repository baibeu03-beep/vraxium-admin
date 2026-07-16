import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  loadLinePointSummaryForCrewWeek,
  loadLineEarnedByRefForCrewWeek,
} from "@/lib/processPointAccrual";
import {
  isSecondEntryEligibleLine,
  loadSecondEntryOverridesForUser,
} from "@/lib/cluster4SecondEntryOverride";
import { formatEnhancementStatusLabel } from "@/lib/cluster4EnhancementLabels";
import { formatProcessHubLabel } from "@/lib/adminProcessesTypes";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import type {
  Cluster4EnhancementReason,
  Cluster4EnhancementStatus,
  Cluster4LinePartType,
  Cluster4LineSubmissionDto,
  Cluster4SubmissionStatus,
} from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 회원별·주차별 상세 "라인 강화 내역" 탭 — 상단 요약 영역 loader (조회 전용).
//
// 핵심 불변식: 크루 페이지(/cluster-4-card)와 동일한 계산 SoT만 표현한다(별도 재추정 금지).
//   · 카드 해석  = resolveCrewWeekCard(액트 탭과 공유) → card.lines / card.points.
//   · 라인 수·결과 = card.lines 를 raw(원소 1개=1라인)로 집계. enhancementStatus 를 그대로 버킷팅.
//   · 전체/오픈/미오픈 = **하단 상세 표와 동일한 raw 라인 행 기준**(lineDetails). 오픈=clubOpen.
//       ⚠ 허브별 breakdown(정보/경험…) 집계나 lineTargetId(대상자) 로 세지 않는다 — 상단 요약과
//       표의 오픈 라인 수가 반드시 일치해야 한다(허브 개수 ≠ 라인 개수).
//   · 주차 성장률  = 이 화면 전용 rawOpenLineGrowthRate(오픈 라인 중 강화 성공 비율, raw 행 기준).
//       ⚠ card.weeklyGrowthRate(breakdownFromLines·허브 SoT)는 정보 허브를 활동유형으로 중복제거해
//       이 표의 오픈 라인 수와 분모가 달라진다. 이 화면은 표와 숫자가 일치해야 하므로 쓰지 않는다.
//   · 오픈 여부   = clubOpen(실제 개설 라인: lineId != null 또는 역량 개설 placeholder). lineTargetId 아님.
//   · 포인트 A/B  = earned(라인 개설 지급 원장 source='line' 합) / possible(이 주차 클럽에서 오픈된
//                  모든 라인의 설정 point_a/point_b 합 — 상세 표의 clubOpen 행과 동일 집합).
//                  ⚠ possible 은 대상자/강화 성공 여부와 무관한 "획득 가능 총합"이다(대상·성공 라인만
//                  합산하면 earned 와 같아져 분모가 무의미). 액트/프로세스/수동/Point C 는 제외.
//   · 포인트 C    = 라인 정책상 지급 원천이 없어 항상 0/0(추정 금지 — 구조만 A/B/C 동형 유지).
//
// 이 페이지는 클럽/주차 공통 데이터(라인 오픈 여부 등)를 조회 근거로만 쓰고 절대 변경하지 않는다.
// ─────────────────────────────────────────────────────────────────────

export type CrewWeekLinePointPair = {
  earned: number;
  possible: number;
};

export type CrewWeekLineSummaryDto = {
  organizationSlug: string | null;
  // 주차 성장률 = rawOpenLineGrowthRate(오픈 라인 중 강화 성공 비율, raw 라인 행 기준).
  //   하단 표의 오픈 라인 수와 분모가 일치한다(허브 SoT card.weeklyGrowthRate 와 의미가 다름).
  weeklyGrowthRate: number;
  // 결과 확정 여부(미확정=집계 전). 미확정 주차엔 pending 라인이 남아 성공+실패+해당없음≠전체가
  //   되므로, 결과 카운트(성공/실패/해당없음)는 확정 주차에서만 노출한다(UI 게이트).
  confirmed: boolean;
  isRestWeek: boolean;
  lines: {
    total: number; // lineDetails.length (raw 라인 행 수)
    open: number; // lineDetails.filter(clubOpen === true)
    unopened: number; // lineDetails.filter(clubOpen === false) (= total - open)
  };
  results: {
    success: number; // enhancementStatus === "success"
    failure: number; // === "fail"
    notApplicable: number; // === "not_applicable"
    pending: number; // === "pending" (미확정 주차 미판정)
  };
  // 라인 강화 결과 포인트 — A/B만. Point C(번개)는 라인 개설 지급 정책에 없어 다루지 않는다(확정 2026-07).
  points: {
    pointA: CrewWeekLinePointPair;
    pointB: CrewWeekLinePointPair;
  };
  // 하단 상세 표(전체 라인 raw). 2차 기입 override 관리 대상.
  lineDetails: CrewWeekLineDetailRow[];
  // 2차 기입 수동 override 를 관리할 수 있는 주차인가(권한 축). 확정(성공/실패/휴식) 주차만.
  //   canEditCrewWeekResult 와 별개 축이지만 이 repo 에선 둘 다 isCrewWeekEditable(확정) 기준.
  canManageSecondEntry: boolean;
};

// 하단 라인 상세 표 + 라인 상세 팝업의 1행. 전부 카드 라인 DTO SoT 를 표현한 값(재추정 없음).
export type CrewWeekLineDetailRow = {
  lineId: string | null; // cluster4_lines.id — override/팝업 키. placeholder 라인은 null.
  lineTargetId: string | null;
  partType: Cluster4LinePartType;
  hubLabel: string; // "실무 정보" 등
  lineName: string;
  displayLineCode: string | null;
  // 클럽 오픈 = 개설된 실제 라인. 일반 허브 = lineId != null. **실무 역량은 예외**: 해당 주차에
  //   역량 개설이 있으면(대상자 존재 → 카드가 placeholder 를 fail/pending 으로 생성) lineId=null 이어도
  //   오픈으로 본다(미개설=not_applicable 만 미오픈). placeholder 의 lineId=null 만 보고 미오픈 판정 금지.
  clubOpen: boolean;
  // 실무 역량 placeholder 행 여부(개설됐으나 이 크루가 아직 대상자 아님 → 라인명 "-"). 성공 전환 시
  //   라인 선택이 필요한 특수 행. 프론트가 이 행 클릭 시 라인 선택 팝업을 연다.
  isCompetencyPlaceholder: boolean;
  enhancementStatus: Cluster4EnhancementStatus;
  enhancementLabel: string; // 강화 성공/실패/해당 없음/집계 전(pending)
  enhancementReason: Cluster4EnhancementReason;
  submissionStatus: Cluster4SubmissionStatus;
  rating: number | null; // 실무 경험 평점(0~10). 그 외 유형/미책정=null → UI "-". 0 과 null 구분.
  earnedA: number; // 라인 원장(source='line', ref_id=line_id) point_check
  earnedB: number; // 라인 원장 point_advantage
  // 2차 기입 — 관리자 수동 override 상태 + 편집권.
  overrideAllowed: boolean; // allowed=true override 존재(수동 허용)
  eligible: boolean; // 허용 전환 가능(클럽오픈 && 본인배정 && 강화성공)
  effectiveCanEdit: boolean; // overlay 반영 canEdit(자동 기간 또는 수동 override)
  // 팝업(조회 전용) 부가 정보.
  submission: Cluster4LineSubmissionDto | null;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

export type CrewWeekLineSummaryResult =
  | { ok: true; data: CrewWeekLineSummaryDto }
  | { ok: false; reason: "member_not_found" | "week_not_found" };

// 이 화면(라인 강화 내역) 전용 주차 성장률 — **실제 오픈된 라인 행 기준**.
//   분모 = clubOpen 인 raw 라인 행 수(허브 집계·활동유형 중복제거 없음, 미오픈/해당없음 제외),
//   분자 = 그중 강화 성공(enhancementStatus === "success") 행 수. 오픈 0 이면 0%.
//   ⚠ card.weeklyGrowthRate(breakdownFromLines·허브 SoT)와 의미가 다르다: 그쪽은 정보 허브를 활동
//     유형으로 중복제거하지만, 이 화면은 상단 요약과 하단 표의 "오픈 라인 수"가 일치해야 하므로
//     표와 동일한 raw 행으로 재계산한다. 같은 의미가 다른 화면에도 필요하면 이 helper 를 재사용한다.
export function rawOpenLineGrowthRate(rows: readonly CrewWeekLineDetailRow[]): number {
  const openCount = rows.filter((r) => r.clubOpen).length;
  if (openCount === 0) return 0;
  const successCount = rows.filter(
    (r) => r.clubOpen && r.enhancementStatus === "success",
  ).length;
  return Math.round((successCount / openCount) * 100);
}

export async function getCrewWeekLineSummary(
  legacyUserId: string,
  weekId: string,
): Promise<CrewWeekLineSummaryResult> {
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { crew, card } = resolved;

  const lines = card.lines;
  const confirmed = isCrewWeekEditable(card.userWeekStatus);

  // 라인 개설 지급 포인트(A/B만) — 원장 earned + 오픈 라인 설정 possible.
  //   possible 분모 = 이 주차 클럽에서 오픈된 모든 라인(card.lines 중 lineId != null = clubOpen).
  //     상세 표의 "오픈" 행과 동일 집합이라 상단 요약과 표 합계가 일치한다. 대상자/성공 여부 무관.
  //   라인별 earned(ref_id=line_id) 와 2차 기입 override 는 상세 표용으로 병렬 로드.
  const openLineIds = Array.from(
    new Set(lines.map((l) => l.lineId).filter((x): x is string => Boolean(x))),
  );
  const [linePoints, earnedByLine, overrideRows] = await Promise.all([
    loadLinePointSummaryForCrewWeek(crew.userId, card.weekId, openLineIds),
    loadLineEarnedByRefForCrewWeek(crew.userId, card.weekId),
    loadSecondEntryOverridesForUser(crew.userId),
  ]);
  const overrideAllowedByLine = new Map<string, boolean>();
  for (const r of overrideRows) {
    if (r.week_id === card.weekId) overrideAllowedByLine.set(r.line_id, r.allowed);
  }

  // 실무 역량 개설 판정: 카드는 개설된 주차에만 역량 placeholder 를 not_applicable 이 아닌
  //   fail/pending 으로 만든다(미개설 = not_applicable). 그래서 competency 는 lineId 유무와 무관하게
  //   "not_applicable 이 아니면 개설"이다. 실 대상자 라인은 lineId != null 로 이미 개설.
  const isCompetencyOpen = (line: (typeof lines)[number]): boolean =>
    line.partType === "competency" && line.enhancementStatus !== "not_applicable";

  const lineDetails: CrewWeekLineDetailRow[] = lines.map((line) => {
    const hubKey = line.partType === "information" ? "info" : line.partType;
    const earned = line.lineId != null ? earnedByLine.get(line.lineId) : undefined;
    return {
      lineId: line.lineId,
      lineTargetId: line.lineTargetId,
      partType: line.partType,
      hubLabel: formatProcessHubLabel(hubKey),
      lineName:
        line.lineName?.trim() ||
        line.mainTitle?.trim() ||
        line.displayLineCode?.trim() ||
        "(이름 없음)",
      displayLineCode: line.displayLineCode,
      clubOpen: line.lineId != null || isCompetencyOpen(line),
      isCompetencyPlaceholder:
        line.partType === "competency" && line.lineId == null && isCompetencyOpen(line),
      enhancementStatus: line.enhancementStatus,
      enhancementLabel: formatEnhancementStatusLabel(line.enhancementStatus),
      enhancementReason: line.enhancementReason,
      submissionStatus: line.submissionStatus,
      rating: line.experienceRating,
      earnedA: earned?.earnedA ?? 0,
      earnedB: earned?.earnedB ?? 0,
      overrideAllowed: line.lineId != null && overrideAllowedByLine.get(line.lineId) === true,
      eligible: isSecondEntryEligibleLine(line),
      effectiveCanEdit: line.canEdit,
      submission: line.submission,
      submissionOpensAt: line.submissionOpensAt,
      submissionClosesAt: line.submissionClosesAt,
    };
  });

  // 전체/오픈/미오픈 — 하단 상세 표(lineDetails)와 **동일한 raw 라인 행** 기준. clubOpen 이 SoT.
  //   허브 breakdown·lineTargetId 로 세지 않는다(허브 개수 ≠ 라인 개수). 오픈+미오픈 == 전체 불변식 성립.
  const total = lineDetails.length;
  const open = lineDetails.filter((r) => r.clubOpen).length;
  const unopened = total - open;

  // 결과 버킷도 동일 raw 행 기준(enhancementStatus). 성공/실패/해당없음/집계전.
  const success = lineDetails.filter((r) => r.enhancementStatus === "success").length;
  const failure = lineDetails.filter((r) => r.enhancementStatus === "fail").length;
  const notApplicable = lineDetails.filter((r) => r.enhancementStatus === "not_applicable").length;
  const pending = lineDetails.filter((r) => r.enhancementStatus === "pending").length;

  // 주차 성장률 = 오픈 라인 중 강화 성공 비율(raw 행). 상단 요약과 하단 표가 항상 일치한다.
  const weeklyGrowthRate = rawOpenLineGrowthRate(lineDetails);

  // 불변식 검증 — 깨지면 숫자를 보정하지 않고 어떤 라인 상태가 누락됐는지 로그로 보고한다.
  if (total !== open + unopened) {
    console.warn("[crewWeekLineSummary] 불변식 위반: total ≠ open + unopened", {
      legacyUserId,
      weekId,
      total,
      open,
      unopened,
    });
  }
  if (confirmed && success + failure + notApplicable !== total) {
    console.warn("[crewWeekLineSummary] 불변식 위반: 확정 주차인데 성공+실패+해당없음 ≠ 전체", {
      legacyUserId,
      weekId,
      total,
      success,
      failure,
      notApplicable,
      pending,
    });
  }

  return {
    ok: true,
    data: {
      organizationSlug: crew.organizationSlug,
      weeklyGrowthRate,
      confirmed,
      isRestWeek: card.isRestWeek,
      lines: { total, open, unopened },
      results: { success, failure, notApplicable, pending },
      points: {
        pointA: { earned: linePoints.earnedA, possible: linePoints.possibleA },
        pointB: { earned: linePoints.earnedB, possible: linePoints.possibleB },
      },
      lineDetails,
      canManageSecondEntry: confirmed,
    },
  };
}
