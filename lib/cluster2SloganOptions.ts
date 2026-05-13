// Cluster2 슬로건 태그 (canonical) 옵션 목록.
//
// ⚠ MIRROR: 사용자 앱 레포 (vraxium) 의 lib/cluster2SloganOptions.ts 와 1:1 동일하게 유지해야 한다.
// 두 레포가 분리되어 있어 직접 import 공유가 불가능하므로 양쪽 파일을 같이 수정한다.
// front 에서 사용처: components/cluster-2/Cluster2Content.tsx (3개의 슬로건 dropdown)
// admin 에서 사용처: components/admin/Cluster2Editor.tsx (Slogans 카드의 tag select)
export const CLUSTER2_SLOGAN_OPTIONS = [
  "Dreamer",
  "Commander",
  "Nomad",
  "Scholar",
  "Warrior",
  "Agent",
  "Pioneer",
  "Architect",
] as const;

export type Cluster2SloganOption = (typeof CLUSTER2_SLOGAN_OPTIONS)[number];

// DB 에 들어 있는 legacy / non-canonical 태그 값을 식별할 때 사용.
// admin editor 가 "기존 값" fallback 옵션으로 노출할지 여부 판정에 쓰인다.
export function isCanonicalSloganOption(
  value: unknown,
): value is Cluster2SloganOption {
  return (
    typeof value === "string" &&
    (CLUSTER2_SLOGAN_OPTIONS as readonly string[]).includes(value)
  );
}
