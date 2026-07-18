import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { formatProcessHubLabel } from "@/lib/adminProcessesTypes";
import {
  loadCompetencyLineTypeByMasterIds,
  resolveLineTypeLabel,
} from "@/lib/adminLineHistoryType";
import { formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import {
  buildImageSlots,
  RESERVED_ADMIN_IMAGE_SLOTS,
  type Cluster4ImageSlot,
  type Cluster4OutputImage,
} from "@/lib/cluster4OutputImages";
import type {
  CareerGrade,
  Cluster4EnhancementStatus,
  Cluster4LinePartType,
  Cluster4OutputLink,
} from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 관리자 라인 상세 팝업(라인 강화 내역 탭 → 라인명 클릭) 조회 DTO.
//   크루 카드(/cluster-4-card)의 동일 라인 DTO SoT 를 그대로 표현(재계산/복제 없음).
//   · 고정(조회 전용): 허브·라인명·라인코드·메인타이틀(클럽 공통)·주차·실무자(경력).
//   · 제출 데이터(서브타이틀·그로스포인트·링크·이미지) = cluster4_line_submissions 단일 행(=성공 A).
//     강화 결과가 실패/해당없음이어도 이 데이터를 삭제/덮어쓰지 않는다(성공 복귀 시 복원). 노출만 상태로 게이트.
//   · 평점 = cluster4_experience_line_evaluations(경험만). 미책정 null 과 실제 0 구분.
// ─────────────────────────────────────────────────────────────────────

export type AdminLineSubmissionDto = {
  subTitle: string | null;
  growthPoint: string | null;
  outputLinks: Cluster4OutputLink[];
  // 예약 슬롯 이미지 모델(2026-07-18): 고정 IMAGE_SLOT_COUNT(4)슬롯. 슬롯 0=운영진(라인 레벨, ≤1),
  //   슬롯 1..3=크루(제출). 빈 슬롯=null(운영진 슬롯이 비어도 크루는 슬롯 1부터 — 앞당김 없음).
  //   filter/compact 로 슬롯을 잃지 않도록 위치를 그대로 보존한다. [[cluster4OutputImages]]
  imageSlots: Cluster4ImageSlot[];
  adminImageSlotCount: number; // 예약 운영진 슬롯 수(RESERVED_ADMIN_IMAGE_SLOTS, 고정)
};

export type AdminCrewWeekLineDetailDto = {
  identity: {
    lineId: string;
    lineTargetId: string | null;
    lineCode: string | null; // 표시용 라인코드(displayLineCode)
    lineName: string;
    partType: Cluster4LinePartType;
    // 유형 — 표와 동일 SoT(resolveLineTypeLabel). 정보/경력=일반·경험=도출/…/견문·역량=원리/…/자원. 미해석=null.
    type: string | null;
    hubLabel: string; // "실무 경험" 등
    mainTitle: string | null; // 클럽 공통 마스터 — 조회 전용
    // 실무 역량 라인의 현재 마스터 id(competency_line_master_id). 라인명/코드/유형의 파생 원천이자
    //   팝업의 "라인명 변경(repoint)" 드롭다운 기본 선택값. 그 외 허브는 null.
    competencyLineMasterId: string | null;
  };
  week: { id: string; label: string; startDate: string; endDate: string };
  organizationSlug: string | null;
  clubOpen: boolean; // lineId != null(개설된 실제 라인)
  currentStatus: Cluster4EnhancementStatus; // 현재 강화 결과(파생/override 반영)
  editable: boolean; // 확정 주차에서만 수정 가능(canManage)
  // 평점 — 경험 라인만 지원. value: null=미책정, 0=실제 0.
  rating: { supported: boolean; value: number | null };
  // 등급 — 경력 라인 강화 결과 레버(S/A/B/C=성공·D=실패). 그 외 허브는 null.
  careerGrade: CareerGrade | null;
  // 실무자 정보 — 경력 라인만. 조회 전용.
  practitioner: {
    companyName: string | null;
    supervisorName: string | null;
    supervisorDepartment: string | null;
    supervisorPosition: string | null;
  } | null;
  // 성공 상태 제출 데이터(A). 실패/해당없음이어도 보존.
  submission: AdminLineSubmissionDto;
};

export type AdminCrewWeekLineDetailResult =
  | { ok: true; data: AdminCrewWeekLineDetailDto }
  | { ok: false; reason: "member_not_found" | "week_not_found" | "line_not_found" };

export async function getCrewWeekLineDetail(
  legacyUserId: string,
  weekId: string,
  lineId: string,
): Promise<AdminCrewWeekLineDetailResult> {
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { crew, card } = resolved;

  const line = card.lines.find((l) => l.lineId != null && l.lineId === lineId);
  if (!line) return { ok: false, reason: "line_not_found" };

  const hubKey = line.partType === "information" ? "info" : line.partType;
  const isCareer = line.partType === "career";
  const sub = line.submission;

  // 유형 = 표와 동일 SoT. 역량만 register 원장(line_type) 브리지 조회 필요.
  const competencyTypeByMaster =
    line.partType === "competency" && line.competencyLineMasterId
      ? await loadCompetencyLineTypeByMasterIds([line.competencyLineMasterId])
      : new Map<string, string>();
  const lineType = resolveLineTypeLabel(line, competencyTypeByMaster);

  // 아웃풋 링크 SoT: submission 우선(2차 기입 편집분), 없으면 라인 레벨 폴백(고객 앱 동일 노출).
  const hasSubLinks = (sub?.outputLinks?.length ?? 0) > 0;
  const outLinks = hasSubLinks ? sub!.outputLinks : line.outputLinks;

  // ── 예약 슬롯 이미지(2026-07-18) — 고객 렌더와 동일한 admin/crew 분리 SoT ──
  //   · 슬롯 0(운영진)  = 라인 레벨 이미지(cluster4_lines.output_images = 카드 top-level line.outputImages).
  //                       고객 카드가 top-level 로 렌더하는 값 그대로. RESERVED_ADMIN_IMAGE_SLOTS(=1)로 클램프.
  //   · 슬롯 1..3(크루) = per-user 제출 이미지(cluster4_line_submissions.output_images = line.submission).
  //   ⚠ 기존 either/or(hasSubImages ? sub : line)는 운영진/크루 이미지를 하나로 뭉개 슬롯을 잃었다(이번 버그).
  //     이제 두 출처를 각자 슬롯에 배치해 순서를 무손실 보존한다(빈 운영진 슬롯도 크루를 앞당기지 않음).
  const adminImageItems: Cluster4OutputImage[] = (line.outputImages ?? []).map((url, i) => ({
    url,
    caption: line.outputImageCaptions?.[i] ?? null,
  }));
  const crewImageItems: Cluster4OutputImage[] = (sub?.outputImages ?? []).map((url, i) => ({
    url,
    caption: sub?.outputImageCaptions?.[i] ?? null,
  }));
  const imageSlots = buildImageSlots(adminImageItems, crewImageItems);

  return {
    ok: true,
    data: {
      identity: {
        lineId,
        lineTargetId: line.lineTargetId,
        lineCode: line.displayLineCode,
        lineName:
          line.lineName?.trim() ||
          line.mainTitle?.trim() ||
          line.displayLineCode?.trim() ||
          "(이름 없음)",
        partType: line.partType,
        type: lineType,
        hubLabel: formatProcessHubLabel(hubKey),
        mainTitle: line.mainTitle,
        competencyLineMasterId:
          line.partType === "competency" ? line.competencyLineMasterId : null,
      },
      week: {
        id: card.weekId,
        label: formatWeekFull(card.seasonKey, card.weekNumber) ?? card.weekLabel ?? "-",
        startDate: card.startDate,
        endDate: card.endDate,
      },
      organizationSlug: crew.organizationSlug,
      clubOpen: line.lineId != null,
      currentStatus: line.enhancementStatus,
      editable: isCrewWeekEditable(card.userWeekStatus),
      rating: {
        supported: line.partType === "experience",
        value: line.experienceRating,
      },
      careerGrade: isCareer ? line.careerGrade : null,
      practitioner: isCareer
        ? {
            companyName: line.companyName,
            supervisorName: line.supervisorName,
            supervisorDepartment: line.supervisorDepartment,
            supervisorPosition: line.supervisorPosition,
          }
        : null,
      submission: {
        subTitle: sub?.subtitle ?? line.infoSubtitle ?? null,
        growthPoint: sub?.growthPoint ?? line.infoGrowthPoint ?? null,
        outputLinks: outLinks ?? [],
        imageSlots,
        adminImageSlotCount: RESERVED_ADMIN_IMAGE_SLOTS,
      },
    },
  };
}
