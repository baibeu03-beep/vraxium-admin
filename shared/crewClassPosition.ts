// 클래스(직책) 표시 SoT — position_code ↔ 클래스 라벨 + role/level → position_code 정규화.
// ─────────────────────────────────────────────────────────────────────
// 두 레포(vraxium / vraxium-admin) 미러 파일. 반드시 byte-identical 유지(parity 스크립트 검증:
//   scripts/verify-crew-class-position-parity). 라벨/코드 규칙은 여기 한 곳에서만 정의한다.
//
// 정책:
//   · as-of-week 클래스 SoT = user_position_histories.position_code (주차 단위).
//   · 스냅샷 카드 DTO(crewClassPositionCode)에는 "라벨"이 아니라 "원시 position_code"를 저장한다.
//     (라벨 문구가 바뀌어도 과거 스냅샷 재생성이 불필요하고 코드↔라벨 불일치 위험이 없다.)
//   · 표시(디테일 로그 등)는 positionCodeToClassLabel 단일 함수로만 변환한다.
//   · 기존 roleLabel(= 멤버십 등급 "일반"/"심화")의 의미는 변경하지 않는다 — 이 파일과 무관.

// admin lib/positionHistory.ts PositionCode 와 동일 union(문자열 리터럴이라 구조적으로 호환).
export type PositionCode =
  | "regular"
  | "advanced_agent"
  | "advanced_part_leader"
  | "operating_team_leader"
  | "operating_ambassador"
  | "operating_club_leader";

// position_code → 클래스 라벨. admin lib/positionHistory.ts POSITION_CODE_TO_LABEL 와 동일 문구.
export const POSITION_CODE_TO_CLASS_LABEL: Record<PositionCode, string> = {
  regular: "정규",
  advanced_agent: "심화(에이전트)",
  advanced_part_leader: "심화(파트장)",
  operating_team_leader: "운영진(팀장)",
  operating_ambassador: "운영진(앰배서더)",
  operating_club_leader: "운영진(클럽장)",
};

const POSITION_CODE_SET = new Set<string>(Object.keys(POSITION_CODE_TO_CLASS_LABEL));

export function isPositionCode(v: unknown): v is PositionCode {
  return typeof v === "string" && POSITION_CODE_SET.has(v);
}

/**
 * position_code → 클래스 라벨. 알 수 없는/빈 코드는 **조용히 regular 로 만들지 않고 null** 을 반환한다
 * (호출부가 과도기 fallback 여부를 결정). 새 필드가 없는 기존 스냅샷은 null 로 떨어져 호출부에서
 * 기존 roleLabel 로 폴백하게 한다.
 */
export function positionCodeToClassLabel(
  code: PositionCode | string | null | undefined,
): string | null {
  if (!code || !isPositionCode(code)) return null;
  return POSITION_CODE_TO_CLASS_LABEL[code];
}

// ── role/level → position_code 정규화 (스냅샷 tier③ freeze 전용) ──────────────
// user_position_histories 에 그 주차 행이 없는 native 주차에서만, 현재 user_profiles.role +
// user_memberships.membership_level 을 그 주차 position_code 로 1회 고정(freeze)할 때 쓴다.
// 등급 SoT 정책(admin memberStatusLabel/currentStatusLabel 과 동일):
//   · 운영진(팀장/앰배서더/클럽장)은 등급 체계 밖 → role 판정 우선.
//   · 심화 등급 내 직책(파트장/에이전트)은 level=심화 게이트 통과 시에만.
//   · 일반 등급 → regular.
// ⚠ 신호가 전무(알 수 없는 role + 등급 미상)하면 regular 로 조용히 변환하지 않고 null 을 반환한다.
function normRole(role: string | null | undefined): string {
  return (role ?? "").trim().toLowerCase();
}
function isAdvancedLevel(level: string | null | undefined): boolean {
  return (level ?? "").trim().startsWith("심화");
}
function isRegularLevel(level: string | null | undefined): boolean {
  const v = (level ?? "").trim().toLowerCase();
  return v === "일반" || v === "regular" || v === "active" || v === "normal";
}
export function roleLevelToPositionCode(
  role: string | null | undefined,
  level: string | null | undefined,
): PositionCode | null {
  const r = normRole(role);
  const raw = (role ?? "").trim();
  // 운영진(등급 체계 밖) — role 우선.
  if (
    r === "team_leader" ||
    r === "operations_team_leader" ||
    r === "operations_teamleader" ||
    raw === "운영진(팀장)" ||
    raw === "팀장"
  ) {
    return "operating_team_leader";
  }
  if (
    r === "ambassador" ||
    r === "operations_ambassador" ||
    raw === "운영진(앰배서더)" ||
    raw === "앰배서더"
  ) {
    return "operating_ambassador";
  }
  if (
    r === "operations_clubleader" ||
    r === "club_leader" ||
    raw === "운영진(클럽장)" ||
    raw === "클럽장"
  ) {
    return "operating_club_leader";
  }
  // 심화 등급 내 직책.
  if (isAdvancedLevel(level)) {
    if (r === "part_leader" || raw === "파트장" || (level ?? "").trim() === "심화(파트장)") {
      return "advanced_part_leader";
    }
    return "advanced_agent";
  }
  // 일반 등급.
  if (isRegularLevel(level)) return "regular";
  // 신호 전무 — 조용히 regular 금지.
  return null;
}
