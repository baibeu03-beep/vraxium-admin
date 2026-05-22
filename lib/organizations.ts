// 단일 출처. 앱 어디에서든 이 상수를 사용한다.
export const ORGANIZATIONS = ["encre", "oranke", "phalanx"] as const;

export type OrganizationSlug = (typeof ORGANIZATIONS)[number];

export const ORGANIZATION_LABEL: Record<OrganizationSlug, string> = {
  encre: "Encre",
  oranke: "Oranke",
  phalanx: "Phalanx",
};

// organization_slug = null 에 대응하는 표시 라벨.
// 모든 어드민 드롭다운/표 표시는 본 상수를 사용한다 (이전: "선택 안 함"/"소속 없음"/"미지정" 혼재).
// "공통" 의미: 특정 조직에 소속되지 않음 = 조직 횡단으로 동작.
export const ORGANIZATION_COMMON_LABEL = "공통";

export function isOrganizationSlug(v: unknown): v is OrganizationSlug {
  return typeof v === "string" && (ORGANIZATIONS as readonly string[]).includes(v);
}
