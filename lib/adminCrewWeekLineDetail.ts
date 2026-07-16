import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import { formatProcessHubLabel } from "@/lib/adminProcessesTypes";
import { formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
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
  outputImages: string[];
  outputImageCaptions: (string | null)[];
};

export type AdminCrewWeekLineDetailDto = {
  identity: {
    lineId: string;
    lineTargetId: string | null;
    lineCode: string | null; // 표시용 라인코드(displayLineCode)
    lineName: string;
    partType: Cluster4LinePartType;
    hubLabel: string; // "실무 경험" 등
    mainTitle: string | null; // 클럽 공통 마스터 — 조회 전용
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
        hubLabel: formatProcessHubLabel(hubKey),
        mainTitle: line.mainTitle,
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
        subTitle: sub?.subtitle ?? null,
        growthPoint: sub?.growthPoint ?? null,
        outputLinks: sub?.outputLinks ?? [],
        outputImages: sub?.outputImages ?? [],
        outputImageCaptions: sub?.outputImageCaptions ?? [],
      },
    },
  };
}
