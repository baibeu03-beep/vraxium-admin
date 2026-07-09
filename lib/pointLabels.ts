import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

export type PointLabelSet = {
  points: string;
  advantages: string;
  penalty: string;
};

export const POINT_LABELS: Record<OrganizationSlug, PointLabelSet> = {
  encre:   { points: "별",  advantages: "방패",   penalty: "번개" },
  oranke:  { points: "단감", advantages: "인절미", penalty: "어흥" },
  phalanx: { points: "투구", advantages: "방패",   penalty: "화살" },
} as const;

export const GRADUATION_THRESHOLDS: Record<OrganizationSlug, number> = {
  encre: 30,
  phalanx: 30,
  oranke: 25,
} as const;

export function getPointLabels(org: OrganizationSlug): PointLabelSet {
  return POINT_LABELS[org];
}

export function getGraduationThreshold(org: OrganizationSlug): number {
  return GRADUATION_THRESHOLDS[org];
}

// ── 프로세스 포인트(po.A/B/C) 표시명 ─────────────────────────────────────
// po.A/B/C 는 내부 키(point_a/b/c · poA/poB/poC)의 UI 표시명일 뿐이다.
// 조직이 확인되면 조직별 명칭으로, 조직 미상(전역/통합/혼합 화면)이면 중립
// "Po.A/B/C" 로 폴백한다. DB 컬럼·계산 로직은 이 매핑과 무관하다.
//   po.A = points(성장) · po.B = advantages(우위) · po.C = penalty(패널티)
//   예) encre → 별/방패/번개 · oranke → 단감/인절미/어흥 · phalanx → 투구/방패/화살
export type ProcessPointKey = "a" | "b" | "c";

export const NEUTRAL_PROCESS_POINT_LABELS: Record<ProcessPointKey, string> = {
  a: "Po.A",
  b: "Po.B",
  c: "Po.C",
};

// 조직 slug(문자열/null/undefined 모두 허용) → po.A/B/C 표시명 3종.
// 유효하지 않은 org 는 중립 라벨로 폴백한다(fail-safe).
export function getProcessPointLabels(
  org: string | null | undefined,
): Record<ProcessPointKey, string> {
  if (!isOrganizationSlug(org)) return NEUTRAL_PROCESS_POINT_LABELS;
  const set = POINT_LABELS[org];
  return { a: set.points, b: set.advantages, c: set.penalty };
}

// 단일 포인트 키의 표시명. org 미상이면 중립.
export function formatProcessPointLabel(
  key: ProcessPointKey,
  org: string | null | undefined,
): string {
  return getProcessPointLabels(org)[key];
}
