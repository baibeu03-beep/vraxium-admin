// 조직별 포인트 표시 메타.
//
// 고객 앱 `vraxium/lib/orgPointMeta.ts`와 같은 화면 계약을 사용한다.
// 내부 식별자(A/B/C)는 사용자 화면에 노출하지 않고 실제 조직별 명칭만 표시한다.

import type { OrganizationSlug } from "@/lib/organizations";

export type OrgPointEntry = {
  name: string;
  icon: string;
};

export const ORG_POINT_META: Record<
  OrganizationSlug,
  readonly [OrgPointEntry, OrgPointEntry, OrgPointEntry]
> = {
  encre: [
    { name: "별", icon: "/images/0/Graphic10.png" },
    { name: "방패", icon: "/images/0/Shield.png" },
    { name: "번개", icon: "/images/0/Graphic13.png" },
  ],
  oranke: [
    { name: "단감", icon: "/images/0/cluster 1/Ok01.png" },
    { name: "인절미", icon: "/images/0/cluster 1/OK02.png" },
    { name: "어흥", icon: "/images/0/cluster 1/Ok03.png" },
  ],
  phalanx: [
    { name: "투구", icon: "/images/0/cluster 1/PX01.png" },
    { name: "방패", icon: "/images/0/cluster 1/pX02.png" },
    { name: "불새", icon: "/images/0/cluster 1/PX03.png" },
  ],
};

export function resolveGrowthStandardPoint(org: OrganizationSlug): OrgPointEntry {
  return ORG_POINT_META[org][0];
}

export function growthStandardLabel(pointName: string): string {
  return `주차 성장 성공 ${pointName} 기준`;
}
