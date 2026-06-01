// Browser-safe types for public-facing cluster4 line APIs.
// Must not import server-only modules here.

import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";
import {
  type Cluster4OutputImage,
  parseOutputImagesInput,
} from "@/lib/cluster4OutputImages";
import type { CareerGrade, CareerRatingStatus } from "@/lib/careerGrade";

export type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";
export type { Cluster4OutputImage } from "@/lib/cluster4OutputImages";
export type { CareerGrade, CareerRatingStatus } from "@/lib/careerGrade";

export type Cluster4LineStatus = "void" | "pending" | "success" | "fail";

export type Cluster4LinePartType =
  | "info"
  | "experience"
  | "competency"
  | "career";

export type Cluster4LineTargetMode = "user" | "rule";

export type Cluster4VisibleLineDto = {
  lineId: string;
  lineTargetId: string;
  partType: Cluster4LinePartType;
  targetMode: Cluster4LineTargetMode;
  mainTitle: string;
  outputLink1: string | null;
  outputLinks: Cluster4OutputLink[];
  submissionOpensAt: string;
  submissionClosesAt: string;

  // 실무 경력(career) sponsor-card 메타 — source: career_projects (career_project_id 로 조회).
  //   companyName 의 SoT 는 career_projects.company_name (supervisor_company 아님).
  //   supervisorPhotoUrl 의 source 는 career_projects.supervisor_profile_img.
  //   career part 에만 값이 들어가고 그 외 part 는 전부 null. (append-only)
  companyName: string | null;
  companyLogoUrl: string | null;
  supervisorName: string | null;
  supervisorDepartment: string | null;
  supervisorPosition: string | null;
  supervisorPhotoUrl: string | null;
};

export type Cluster4LineSubmissionDto = {
  id: string;
  lineTargetId: string;
  subtitle: string | null;
  // 크루원 제출 그로스 포인트 (4개 허브 공통 제출 필드). 미제출/구버전 응답이면 null.
  growthPoint: string | null;
  outputLink2: string | null;
  outputLink3: string | null;
  outputLink4: string | null;
  outputLink5: string | null;
  outputLinks: Cluster4OutputLink[];
  // 크루원 제출 이미지 (URL 목록 + index 정렬 일치 캡션). 없으면 [].
  outputImages: string[];
  outputImageCaptions: (string | null)[];
  submittedAt: string;
  updatedAt: string;
};

// 실무 경험 5슬롯 분류 (cluster4_experience_line_masters.experience_category).
// slot 과 1:1: derivation=1, analysis=2, evaluation=3, extension=4, management=5.
export type Cluster4ExperienceCategory =
  | "derivation"
  | "analysis"
  | "evaluation"
  | "extension"
  | "management";

export type Cluster4LineDetailDto = {
  status: Cluster4LineStatus;
  partType: Cluster4LinePartType;
  line: Cluster4VisibleLineDto | null;
  submission: Cluster4LineSubmissionDto | null;
  // 실무 경험 평점 — 운영자/평가값. source: cluster4_experience_line_evaluations.rating (0~10).
  //   (line_target_id + user_id) 단위로 현재 대상자의 평점만 매핑. experience 외 part 또는 미평가 시 null.
  //   사용자 제출값(submission)과 무관. 프론트는 null 이면 "-" fallback.
  experienceRating: number | null;
  // 실무 경험 5슬롯 분류 — source: cluster4_experience_line_masters.experience_category / experience_slot_order.
  //   join: cluster4_lines.experience_line_master_id → masters.id. experience 외 part 또는 미분류 시 null.
  experienceCategory: Cluster4ExperienceCategory | null;
  experienceSlotOrder: number | null;
  // 실무 경력 평점 — source: cluster4_career_line_evaluations.grade / grade_points (P0).
  //   (line_target_id + user_id) 단위로 현재 대상자의 평점만 매핑. career 외 part 또는 미평가 시 null.
  //   weekly-cards DTO 와 동일 값. grade: S/A/B/C/D, gradePoints: 10/8/6/4/2.
  careerGrade: CareerGrade | null;
  careerGradePoints: number | null;
  // 평가 결과 축 (마감 무관). unevaluated/success/fail. career 외 part 는 null.
  careerRatingStatus: CareerRatingStatus | null;
};

export type Cluster4LineSubmissionInput = {
  subtitle: string | null;
  // 크루원 제출 그로스 포인트 (4개 허브 공통).
  growthPoint: string | null;
  outputLink2: string | null;
  outputLink3: string | null;
  outputLink4: string | null;
  outputLink5: string | null;
  // 신규 canonical 구조. 저장 시 output_links jsonb 로 기록하고 레거시 컬럼에도 mirror 한다.
  outputLinks: Cluster4OutputLink[];
  // 크루원 제출 이미지. 저장 시 output_images jsonb([{url,caption}]) 로 기록.
  outputImages: Cluster4OutputImage[];
};

export type ParseSubmissionBodyResult =
  | { ok: true; value: Cluster4LineSubmissionInput }
  | { ok: false; status: number; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTextField(
  raw: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length ? trimmed : null };
}

export function parseCluster4LineSubmissionBody(
  body: unknown,
): ParseSubmissionBodyResult {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const subtitle = normalizeTextField(body.subtitle, "subtitle");
  if (!subtitle.ok) return { ok: false, status: 400, error: subtitle.error };
  const growthPoint = normalizeTextField(body.growth_point, "growth_point");
  if (!growthPoint.ok) return { ok: false, status: 400, error: growthPoint.error };
  const outputLink2 = normalizeTextField(body.output_link_2, "output_link_2");
  if (!outputLink2.ok) return { ok: false, status: 400, error: outputLink2.error };
  const outputLink3 = normalizeTextField(body.output_link_3, "output_link_3");
  if (!outputLink3.ok) return { ok: false, status: 400, error: outputLink3.error };
  const outputLink4 = normalizeTextField(body.output_link_4, "output_link_4");
  if (!outputLink4.ok) return { ok: false, status: 400, error: outputLink4.error };
  const outputLink5 = normalizeTextField(body.output_link_5, "output_link_5");
  if (!outputLink5.ok) return { ok: false, status: 400, error: outputLink5.error };

  // output_links 우선. 미제공 시 레거시 output_link_2~5 로부터 파생.
  const parsedLinks = parseOutputLinksInput(body.output_links);
  if (!parsedLinks.ok) return { ok: false, status: 400, error: parsedLinks.error };
  const outputLinks =
    parsedLinks.value.length > 0
      ? parsedLinks.value
      : outputLinksFromLegacy([
          outputLink2.value,
          outputLink3.value,
          outputLink4.value,
          outputLink5.value,
        ]);

  // 크루원 제출 이미지. string[] 또는 [{url,caption}] 모두 허용. 미지정이면 [].
  const parsedImages = parseOutputImagesInput(body.output_images);
  if (!parsedImages.ok) return { ok: false, status: 400, error: parsedImages.error };

  return {
    ok: true,
    value: {
      subtitle: subtitle.value,
      growthPoint: growthPoint.value,
      outputLink2: outputLink2.value,
      outputLink3: outputLink3.value,
      outputLink4: outputLink4.value,
      outputLink5: outputLink5.value,
      outputLinks,
      outputImages: parsedImages.value,
    },
  };
}
