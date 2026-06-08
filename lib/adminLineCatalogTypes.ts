// Browser-safe types for the unified line catalog (Phase 2B — read-only merge view).
//
// 정책 (2026-06-07 Phase 2B):
//   - 4개 원천(경험/역량 마스터 · career_projects · line_registrations)을 "조회 시점에만"
//     merge 한다. 물리 통합/이관/변환/개설 연결 일절 없음 — read-only.
//   - 기존 SoT·기존 API 응답·개설 플로우·snapshot 은 무접촉.

import type { LineRegistrationHub } from "@/lib/adminLineRegistrationsTypes";

export type LineCatalogSource =
  | "experience_master"
  | "competency_master"
  | "career_master"
  | "registration";

export const LINE_CATALOG_SOURCES = [
  "experience_master",
  "competency_master",
  "career_master",
  "registration",
] as const;

export const LINE_CATALOG_SOURCE_LABEL: Record<LineCatalogSource, string> = {
  experience_master: "경험 마스터",
  competency_master: "역량 마스터",
  career_master: "경력 마스터",
  registration: "신규 등록",
};

export type LineCatalogSort = "latest" | "oldest";

export type LineCatalogItemDto = {
  // React key / 행 식별용 — 원천 uuid 에 source prefix 를 붙인 합성 키 (원천 간 충돌 방지).
  key: string;
  // 원천 행의 raw id (uuid).
  sourceId: string;
  source: LineCatalogSource;
  sourceLabel: string;
  lineName: string;
  hub: LineRegistrationHub;
  hubLabel: string;
  // 라인 종류 — 경험 마스터: experience_category 한글 매핑 / 역량 마스터: 원천 부재 "-" /
  // 경력 마스터: "일반"(단일 종류) / 신규 등록: line_type 그대로.
  lineType: string;
  lineCode: string | null;
  // 메인 타이틀 — 원천 컬럼 그대로 (없으면 null). 신규 등록 변동(variable)은 "-".
  mainTitle: string | null;
  // 신규 등록만 고정/변동 구분 보유 — 마스터 원천은 null.
  mainTitleMode: "fixed" | "variable" | null;
  // 등록 상태 — is_active 기반 (career_projects 는 is_active 컬럼 부재 → 상시 "활성").
  registrationStatus: "활성" | "비활성";
  organizationSlug: string | null;
  // Phase 2C — source=registration 행 전용: 브리지된 마스터 id (마스터 원천 행은 항상 null).
  bridgedMasterId: string | null;
  // Phase 2E-6 — 마스터 원천 행 전용: registration 에 mirror 된 행(중복 표시 대상).
  // 데이터는 보존하되 UI 기본 표시에서 숨긴다 (registration 행이 대표). registration 행은 false.
  mirrored: boolean;
  createdAt: string | null;
};

export type ListLineCatalogResult = {
  rows: LineCatalogItemDto[];
  total: number;
  // 원천별 건수 — 기존 마스터 건수와의 정합 검증용.
  countsBySource: Record<LineCatalogSource, number>;
};
