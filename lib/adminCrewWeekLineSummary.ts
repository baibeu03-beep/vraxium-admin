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
import {
  INFO_LINE_TYPE_LABEL,
  experienceTypeDisplayOrder,
  loadCompetencyLineTypeByMasterIds,
  loadInfoLineCatalog,
  resolveLineTypeLabel,
  type InfoLineCatalogEntry,
} from "@/lib/adminLineHistoryType";
import { computeCluster4Enhancement } from "@/lib/cluster4Enhancement";
import { foldExperienceSlots } from "@/lib/experienceSlotFold";
import { rawOpenLineGrowthRate } from "@/lib/lineHistoryGrowthRate";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import type { Cluster4LineDetailDto } from "@/shared/cluster4.contracts";
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
  // 유형(도출/분석/견문/관리/확장·원리/기술/관점/자원·일반) — adminLineHistoryType 단일 SoT.
  //   register 원장(line_registrations.line_type) 기준. 미해석(브리지 없음 등)=null → UI "-".
  type: string | null;
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
  // 실무 경험 비대상(오픈+강화 실패) 슬롯 — 본인 라인이 없어 lineId=null. 팝업에서 강화 결과를 성공으로
  //   바꾸면 이 유형의 라인 선택 드롭다운을 노출하고, 선택·저장 시 실제 line/target 을 생성해 성공 수렴한다
  //   (역량 placeholder 아날로그). 타인 라인 인스턴스를 대표로 쓰지 않는다.
  isExperiencePlaceholder: boolean;
  experienceCategory: string | null; // 경험 유형 코드(derivation/analysis/…) — 라인 선택 스코프.
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

// 이 화면(라인 강화 내역) 전용 주차/허브 성장률 — 순수 함수라 client-safe 모듈로 분리했다
//   (클라이언트 컴포넌트가 서버 전용 체인 supabaseAdmin 을 번들하지 않도록). 기존 import 경로 호환 재노출.
export { rawOpenLineGrowthRate };

export async function getCrewWeekLineSummary(
  legacyUserId: string,
  weekId: string,
): Promise<CrewWeekLineSummaryResult> {
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { crew, card } = resolved;

  const lines = card.lines;
  const confirmed = isCrewWeekEditable(card.userWeekStatus);

  // 휴식 주차(개인/공식) — 기존 카드 정책과 동일하게 라인 목록을 생성하지 않는다(요구: 휴식주는
  //   일반 주차와 달리 정보 8행·경험 5행 같은 라인 목록을 만들지 않고 조회 전용 휴식 상태만 표시).
  //   카드 자체가 breakdown 을 비우고(emptyBreakdown) cardMessage 로 휴식을 알리는 정책과 정합.
  if (card.isRestWeek) {
    return {
      ok: true,
      data: {
        organizationSlug: crew.organizationSlug,
        weeklyGrowthRate: 0,
        confirmed,
        isRestWeek: true,
        lines: { total: 0, open: 0, unopened: 0 },
        results: { success: 0, failure: 0, notApplicable: 0, pending: 0 },
        points: {
          pointA: { earned: 0, possible: 0 },
          pointB: { earned: 0, possible: 0 },
        },
        lineDetails: [],
        canManageSecondEntry: false,
      },
    };
  }

  // 라인 개설 지급 포인트(A/B만) — 원장 earned + 오픈 라인 설정 possible.
  //   possible 분모 = 이 주차 클럽에서 오픈된 모든 라인(**원본** card.lines 중 lineId != null = clubOpen).
  //     ⚠ 표시용 lineDetails 는 아래에서 경험 유령행 제거·정보 8행 enumerate 로 재구성되지만, 포인트
  //       획득 가능 총합(possible)은 배정/표시와 무관한 "클럽 오픈 라인 전체"이므로 원본에서 뽑는다.
  //   라인별 earned(ref_id=line_id) 와 2차 기입 override 는 상세 표용으로 병렬 로드.
  const openLineIds = Array.from(
    new Set(lines.map((l) => l.lineId).filter((x): x is string => Boolean(x))),
  );
  // 역량 유형(원리/기술/관점/자원) = register 원장 line_type. competency master 브리지로 일괄 조회.
  const competencyMasterIds = lines
    .filter((l) => l.partType === "competency" && l.competencyLineMasterId)
    .map((l) => l.competencyLineMasterId as string);

  const [linePoints, earnedByLine, overrideRows, competencyTypeByMaster, infoCatalog] =
    await Promise.all([
      loadLinePointSummaryForCrewWeek(crew.userId, card.weekId, openLineIds),
      loadLineEarnedByRefForCrewWeek(crew.userId, card.weekId),
      loadSecondEntryOverridesForUser(crew.userId),
      loadCompetencyLineTypeByMasterIds(competencyMasterIds),
      loadInfoLineCatalog(crew.organizationSlug),
    ]);
  const overrideAllowedByLine = new Map<string, boolean>();
  for (const r of overrideRows) {
    if (r.week_id === card.weekId) overrideAllowedByLine.set(r.line_id, r.allowed);
  }

  // 실무 역량 개설 판정: 카드는 개설된 주차에만 역량 placeholder 를 not_applicable 이 아닌
  //   fail/pending 으로 만든다(미개설 = not_applicable). 그래서 competency 는 lineId 유무와 무관하게
  //   "not_applicable 이 아니면 개설"이다. 실 대상자 라인은 lineId != null 로 이미 개설.
  const isCompetencyOpen = (line: Cluster4LineDetailDto): boolean =>
    line.partType === "competency" && line.enhancementStatus !== "not_applicable";

  // 카드 라인 1건 → 표 1행. 유형/표시 라인명은 호출부가 결정(정보=원장 카탈로그명, 그 외=마스터명).
  //   ⚠ 표와 팝업은 유형을 각자 계산하지 않는다 — resolveLineTypeLabel(단일 SoT)만 쓴다(요구 §5).
  const toRow = (
    line: Cluster4LineDetailDto,
    opts: { type: string | null; displayName: string; displayLineCode?: string | null },
  ): CrewWeekLineDetailRow => {
    const earned = line.lineId != null ? earnedByLine.get(line.lineId) : undefined;
    return {
      lineId: line.lineId,
      lineTargetId: line.lineTargetId,
      partType: line.partType,
      type: opts.type,
      hubLabel: formatProcessHubLabel(
        line.partType === "information" ? "info" : line.partType,
      ),
      lineName: opts.displayName,
      displayLineCode: opts.displayLineCode ?? line.displayLineCode,
      clubOpen: line.lineId != null || isCompetencyOpen(line),
      isCompetencyPlaceholder:
        line.partType === "competency" && line.lineId == null && isCompetencyOpen(line),
      isExperiencePlaceholder: false, // 경험 슬롯은 buildExperienceRow 에서만 설정
      experienceCategory: null,
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
  };

  // 개설된 실제 라인만 마스터 라인명, placeholder(lineId 없음)는 "-"(선택된 라인 없음).
  const masterDisplayName = (line: Cluster4LineDetailDto): string =>
    line.lineId != null
      ? line.lineName?.trim() ||
        line.mainTitle?.trim() ||
        line.displayLineCode?.trim() ||
        "(이름 없음)"
      : "-";

  // 정보 미오픈(이 주차 미개설) 정식 라인 행 — 항상 8행 표시(요구 §3-1). clubOpen=false, 해당 없음.
  const infoUnopenedRow = (entry: InfoLineCatalogEntry): CrewWeekLineDetailRow => {
    const enh = computeCluster4Enhancement({
      hasTarget: false,
      deadlinePassed: false,
      hasSubmission: false,
      isCareer: false,
      expectedWhenMissing: false,
    });
    return {
      lineId: null,
      lineTargetId: null,
      partType: "information",
      type: INFO_LINE_TYPE_LABEL,
      hubLabel: formatProcessHubLabel("info"),
      lineName: entry.lineName,
      displayLineCode: entry.displayLineCode,
      clubOpen: false,
      isCompetencyPlaceholder: false,
      isExperiencePlaceholder: false,
      experienceCategory: null,
      enhancementStatus: enh.enhancementStatus,
      enhancementLabel: formatEnhancementStatusLabel(enh.enhancementStatus),
      enhancementReason: enh.enhancementReason,
      submissionStatus: enh.submissionStatus,
      rating: null,
      earnedA: 0,
      earnedB: 0,
      overrideAllowed: false,
      eligible: false,
      effectiveCanEdit: false,
      submission: null,
      submissionOpensAt: null,
      submissionClosesAt: null,
    };
  };

  // ── 정보(§3-1): 기타A 제외 정식 8라인 항상 표시. 카드 정보행과 활동유형으로 매칭해 상태 부여 ──
  //   라인명 = 원장(line_registrations) 정식 라인명(Main Title/공표글 제목 아님). 유형 = 일반.
  const infoRows: CrewWeekLineDetailRow[] = infoCatalog.map((entry) => {
    const candidates = lines.filter(
      (l) =>
        l.partType === "information" &&
        (l.activityTypeId === entry.activityTypeId ||
          l.activityTypeKey === entry.activityTypeId),
    );
    // 대표 = 본인 배정 > 오픈(타인) > 첫 카드행. 없으면 미오픈 합성 행.
    const pick =
      candidates.find((l) => l.lineId != null && l.lineTargetId != null) ??
      candidates.find((l) => l.lineId != null) ??
      candidates[0] ??
      null;
    return pick
      ? toRow(pick, {
          type: INFO_LINE_TYPE_LABEL,
          displayName: entry.lineName,
          displayLineCode: entry.displayLineCode,
        })
      : infoUnopenedRow(entry);
  });

  // ── 경험(§3-2 정정): 유형 슬롯 폴딩 — 유형(도출/분석/견문/관리/확장) 슬롯당 1행. 슬롯 자체는 제거하지
  //   않고, 다른 사용자에게 선택된 실제 라인명만 숨긴다("-"). 오픈된 비대상 슬롯의 강화 실패는 유지한다.
  //     · 본인 배정(lineTargetId!=null)              → 실제 라인명 · 오픈 · 본인 강화 결과(성공/실패).
  //     · 오픈+본인 비대상(타인 라인/required_fail)  → "-" · 오픈 · 강화 실패. lineId/target 숨김 →
  //       팝업이 타인 라인을 열거나 2차 기입/earned 가 본인 것처럼 잡히지 않게 한다(§6).
  //     · 미오픈(not_opened/na placeholder)          → "-" · 미오픈 · 해당 없음.
  //   클럽 오픈 여부 = enhancementStatus !== "not_applicable"(요구 정책). ⚠ 성장률 집계
  //   (breakdownFromLines)와 "같은 배열 필터"로 처리하지 않는다 — 표는 슬롯을 유지하고, 성장률은
  //   별도 정책이다(관리자 표는 자체 폴딩으로 배지↔허브요약 내부 일관, 고객 카드 성장률과의 정합은 감사·보고).
  const buildExperienceRow = (rep: Cluster4LineDetailDto): CrewWeekLineDetailRow => {
    const isOwn = rep.lineTargetId != null; // 본인에게 실제 배정(선택)된 라인
    const opened = rep.enhancementStatus !== "not_applicable";
    const earned = isOwn && rep.lineId != null ? earnedByLine.get(rep.lineId) : undefined;
    return {
      lineId: isOwn ? rep.lineId : null, // 비대상/placeholder = 팝업·2차기입 차단(타인 라인 노출 금지)
      lineTargetId: isOwn ? rep.lineTargetId : null,
      partType: "experience",
      type: resolveLineTypeLabel(rep, competencyTypeByMaster),
      hubLabel: formatProcessHubLabel("experience"),
      lineName: isOwn ? masterDisplayName(rep) : "-", // 타인 선택 라인명 미노출
      displayLineCode: isOwn ? rep.displayLineCode : null,
      clubOpen: opened,
      isCompetencyPlaceholder: false,
      // 오픈+비대상(강화 실패) 슬롯 = 경험 placeholder(팝업에서 라인 선택→성공 전환 가능). 미오픈은 제외.
      isExperiencePlaceholder: !isOwn && opened,
      experienceCategory: rep.experienceCategory,
      enhancementStatus: rep.enhancementStatus,
      enhancementLabel: formatEnhancementStatusLabel(rep.enhancementStatus),
      enhancementReason: rep.enhancementReason,
      submissionStatus: rep.submissionStatus,
      rating: isOwn ? rep.experienceRating : null,
      earnedA: earned?.earnedA ?? 0,
      earnedB: earned?.earnedB ?? 0,
      overrideAllowed:
        isOwn && rep.lineId != null && overrideAllowedByLine.get(rep.lineId) === true,
      eligible: isOwn ? isSecondEntryEligibleLine(rep) : false,
      effectiveCanEdit: isOwn ? rep.canEdit : false,
      submission: isOwn ? rep.submission : null,
      submissionOpensAt: isOwn ? rep.submissionOpensAt : null,
      submissionClosesAt: isOwn ? rep.submissionClosesAt : null,
    };
  };
  // 유형 슬롯 폴딩 = **성장률/크루 카드와 동일한 공통 resolver**(foldExperienceSlots). 슬롯당 1행.
  //   화면별 별도 계산 금지 — 관리자 표의 오픈/성공 집계가 breakdownFromLines(experienceBreakdownFromFold)와
  //   구조적으로 일치한다(3/4 = 75% 동일). 레거시/휴식은 슬롯 모델이 없어 카드가 주는 만큼만 접힌다.
  const experienceRows: CrewWeekLineDetailRow[] = foldExperienceSlots(lines)
    .map((s) => buildExperienceRow(s.rep))
    .sort((a, b) => experienceTypeDisplayOrder(a.type) - experienceTypeDisplayOrder(b.type));

  // ── 역량(§3-3): 카드가 1인·1주차 1칸으로 fold(2.7). 그대로 1행. 유형=원장 line_type, 미선택=-. ──
  const competencyRows: CrewWeekLineDetailRow[] = lines
    .filter((l) => l.partType === "competency")
    .map((l) =>
      toRow(l, {
        type: resolveLineTypeLabel(l, competencyTypeByMaster),
        displayName: masterDisplayName(l),
      }),
    );

  // ── 경력(§3-4): 실제 오픈된 라인만 표시(미오픈 void 패딩 제외). 유형=일반. ──
  const careerRows: CrewWeekLineDetailRow[] = lines
    .filter((l) => l.partType === "career" && l.lineId != null)
    .map((l) =>
      toRow(l, {
        type: resolveLineTypeLabel(l, competencyTypeByMaster),
        displayName: masterDisplayName(l),
      }),
    );

  // 표시 순서 = 정보(카탈로그) → 경험(슬롯) → 역량 → 경력(오픈). 결정적 순서로 안정 렌더.
  const lineDetails: CrewWeekLineDetailRow[] = [
    ...infoRows,
    ...experienceRows,
    ...competencyRows,
    ...careerRows,
  ];

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
