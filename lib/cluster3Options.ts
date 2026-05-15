// Cluster3 dropdown / multi-select 옵션 — canonical 목록.
//
// ⚠ MIRROR: 사용자 앱 레포 (vraxium) 의 components/cluster-3/Cluster3Content.tsx 안에
// 인라인 상수로 동일하게 정의되어 있다. 두 레포가 분리되어 직접 import 공유가
// 불가능하므로 양쪽을 동일 값으로 유지해야 한다. front 에서 옵션이 추가/변경되면
// 본 파일도 반드시 같이 갱신.
//
// 저장 형식 정책:
//   - PLATFORM / MANAGEMENT / STATUS: label string 그대로 (예: "유튜브", "개인 소유 관리").
//     DB 컬럼에는 한글 label 이 들어간다.
//   - ROLES / TOOLS: 영문 key 만 저장 (예: ["leading", "notion"]).
//     UI 는 label 을 보여주지만 DB 에는 key 만. front 의 `selectedTools.includes(tool.key)`
//     비교 패턴이 이를 강제한다.

// ─────────────────────────────────────────────────────────────────────
// Channel cards (Section 3 · portfolio_channel_cards)
// ─────────────────────────────────────────────────────────────────────

// front Cluster3Content.tsx:1198 PLATFORM_ICONS 의 key 순서 그대로.
// 공용 (output / detail 카드의 platform 도 같은 set).
export const PLATFORM_OPTIONS = [
  "유튜브",
  "인스타그램",
  "블로그(네이버)",
  "티스토리",
  "X(트위터)",
  "스레드(메타)",
  "카카오스토리",
  "핀터레스트",
  "틱톡",
  "비핸스",
  "노션",
] as const;

export type PlatformOption = (typeof PLATFORM_OPTIONS)[number];

// front Cluster3Content.tsx:1212
export const MANAGEMENT_OPTIONS = [
  "개인 소유 관리",
  "팀 소속 협업",
  "기타 진행",
] as const;

export type ManagementOption = (typeof MANAGEMENT_OPTIONS)[number];

// front Cluster3Content.tsx:1213
export const STATUS_OPTIONS = ["운영 중", "운영 중단", "운영 보류"] as const;

export type StatusOption = (typeof STATUS_OPTIONS)[number];

// ─────────────────────────────────────────────────────────────────────
// Top cards (Section 4 output · Section 5 detail · portfolio_top_cards)
// ─────────────────────────────────────────────────────────────────────

// front Cluster3Content.tsx:1244 ROLE_OPTIONS 와 1:1.
// admin 은 color 필드를 사용하지 않으므로 key/label 만 보유.
export type Cluster3KeyLabel = { key: string; label: string };

export const ROLE_OPTIONS: readonly Cluster3KeyLabel[] = [
  { key: "leading", label: "리딩" },
  { key: "following", label: "팔로잉" },
  { key: "management", label: "관리" },
  { key: "planning", label: "기획" },
  { key: "execution", label: "진행" },
  { key: "analysis", label: "분석" },
  { key: "production", label: "제작" },
  { key: "support", label: "지원" },
  { key: "communication", label: "소통" },
  { key: "etc", label: "기타" },
] as const;

export const ROLE_OPTION_KEYS: readonly string[] = ROLE_OPTIONS.map(
  (o) => o.key,
);

// front Cluster3Content.tsx:1256 TOOL_OPTIONS 와 1:1. icon 필드는 admin 미사용.
export const TOOL_OPTIONS: readonly Cluster3KeyLabel[] = [
  { key: "notion", label: "노션" },
  { key: "figma", label: "피그마" },
  { key: "excel", label: "엑셀" },
  { key: "powerpoint", label: "파워포인트" },
  { key: "word", label: "워드프로세서" },
  { key: "photoshop", label: "포토샵" },
  { key: "illustrator", label: "일러스트레이터" },
  { key: "premiere", label: "프리미어프로" },
  { key: "canva", label: "캔바" },
  { key: "miricanvas", label: "미리캔버스" },
  { key: "midjourney", label: "미드저니" },
  { key: "chatgpt", label: "챗지피티" },
  { key: "claude", label: "클로드" },
  { key: "discord", label: "디스코드" },
  { key: "zoom", label: "줌" },
  { key: "etc", label: "기타" },
] as const;

export const TOOL_OPTION_KEYS: readonly string[] = TOOL_OPTIONS.map(
  (o) => o.key,
);

// ─────────────────────────────────────────────────────────────────────
// Canonical 판정 helper
//
// admin UI 가 "DB 에 있는 값이 canonical 옵션 목록에 있는가" 를 빠르게 판단해
// 없으면 "기존 값" fallback 으로 노출한다 (값 유실 방지).
// ─────────────────────────────────────────────────────────────────────

export function isCanonicalPlatform(value: unknown): value is PlatformOption {
  return (
    typeof value === "string" &&
    (PLATFORM_OPTIONS as readonly string[]).includes(value)
  );
}

export function isCanonicalManagement(
  value: unknown,
): value is ManagementOption {
  return (
    typeof value === "string" &&
    (MANAGEMENT_OPTIONS as readonly string[]).includes(value)
  );
}

export function isCanonicalStatus(value: unknown): value is StatusOption {
  return (
    typeof value === "string" &&
    (STATUS_OPTIONS as readonly string[]).includes(value)
  );
}

export function isCanonicalRoleKey(value: unknown): boolean {
  return typeof value === "string" && ROLE_OPTION_KEYS.includes(value);
}

export function isCanonicalToolKey(value: unknown): boolean {
  return typeof value === "string" && TOOL_OPTION_KEYS.includes(value);
}

// label 조회 — DB 에는 key 가 들어있고 UI 는 label 을 보여준다.
// 매칭 실패 시 key 자체를 반환 (legacy 값을 그대로 표시).
export function getRoleLabel(key: string): string {
  return ROLE_OPTIONS.find((o) => o.key === key)?.label ?? key;
}

export function getToolLabel(key: string): string {
  return TOOL_OPTIONS.find((o) => o.key === key)?.label ?? key;
}
