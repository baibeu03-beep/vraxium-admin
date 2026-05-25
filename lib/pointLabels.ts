import type { OrganizationSlug } from "@/lib/organizations";

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
