import {
  POSITION_CODE_TO_CLASS_LABEL,
  isPositionCode,
  positionCodeToClassLabel,
  roleLevelToPositionCode,
  type PositionCode,
} from "@/shared/crewClassPosition";

const CLASS_LABEL_VALUES = new Set<string>(Object.values(POSITION_CODE_TO_CLASS_LABEL));

// Browser-safe constants and types for the /admin/members view.
// Must not import any server-only modules (supabaseAdmin, next/headers, ...),
// because client components import from here.

import type { ScopeMode } from "@/lib/userScopeShared";

export type AdminMemberDto = {
  userId: string;
  displayName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  authEmail: string | null;
  organizationSlug: string | null;
  status: string | null;
  growthStatus: string | null;
  // 성장 중단(suspended)이 적용된 주차(weeks.id). growth_status=suspended 일 때만 의미.
  //   고객 카드 목록의 "성장 중단" 배지를 이 주차 카드 1장에만 표시하기 위한 SoT. 없으면 null.
  suspendedWeekId: string | null;
  role: string | null;
  // user_memberships(is_current=true).membership_level 원본 ("일반"/"심화", 없으면 null).
  membershipLevel: string | null;
  // 상태 칩 표기 = memberStatusLabel(role, membershipLevel). 등급 SoT 는
  // membership_level 이며 role 단독으로 "파트장"을 만들지 않는다(아래 함수 주석 참조).
  statusLabel: string;
  // 클래스 컬럼 표기(정규/심화(파트장)/…). 종전에는 화면이 classLabel(role, membershipLevel) 로
  //   **클라이언트에서** 만들었는데, 현재 주차 파트/클래스 override 는 role/membershipLevel 을
  //   건드리지 않으므로 화면이 영원히 멤버십 값을 보여줬다. 서버가 override 를 반영해 계산한
  //   이 값을 화면이 우선 사용한다(없으면 종전 클라이언트 계산으로 폴백).
  classLabel: string;
  // user_memberships(is_current=true) 의 비정규화 값 (읽기 전용 — 트리거가 동기화).
  currentTeamName: string | null;
  currentPartName: string | null;
  // 전체기간 포인트 집계 = user_weekly_points 직접합산(시즌/주차/타입 무필터).
  // user_profiles 에는 캐시 컬럼이 없어 listMembers 가 집계해 채운다(읽기 전용).
  // 이력서 카드의 누적 포인트와 동일한 단일 SoT 합산이며, null 은 0 으로 합산한다.
  // 포인트 표시 정책(2026-06-04 통일): 고객 화면 방패 = net(advantage − penalty).
  //   checkPoints        = SUM(points)      (이력서 "별", check)
  //   advantagePoints    = SUM(advantages)  (raw — 내부 집계/검증 전용, 고객 미노출)
  //   penaltyPoints      = SUM(penalty)     (원본값. 고객 화면에는 −penalty 로 표시)
  //   netAdvantagePoints = advantagePoints − penaltyPoints (고객 화면 표시 방패)
  checkPoints: number;
  advantagePoints: number;
  penaltyPoints: number;
  netAdvantagePoints: number;
  createdAt: string | null;
  updatedAt: string | null;
};

// 상태 칩 라벨 — 등급 SoT = user_memberships.membership_level(일반/심화).
// user_profiles.role 은 보조 정보로만 쓴다:
//   - 운영진(team_leader/ambassador, 관리자 계정)은 멤버십 등급 체계 밖 → role 표기.
//   - "심화" 등급의 직책 구분(파트장/에이전트)에만 role 을 참조한다.
// role=part_leader 여도 level=일반이면 "일반" — "심화(파트장)" 일 때만 파트장 표기.
// (cluster4 statusLabel 도메인과 동일한 라벨 집합: 일반/심화(파트장)/심화(에이전트)/팀장/앰배서더)
export function memberStatusLabel(
  role: string | null,
  membershipLevel: string | null,
): string {
  if (role === "super_admin") return "최고 관리자";
  if (role === "admin") return "관리자";
  if (role === "team_leader") return "팀장";
  if (role === "ambassador") return "앰배서더";
  const lv = (membershipLevel ?? "").trim();
  if (lv.startsWith("심화")) {
    if (role === "part_leader" || lv === "심화(파트장)") return "심화(파트장)";
    return "심화(에이전트)";
  }
  if (lv === "일반") return "일반";
  return "크루"; // 멤버십 등급 정보 없음 → 등급 미부여 기본 표기
}

// position_code → **memberStatusLabel 과 같은 어휘**(일반/심화(파트장)/…)로 변환.
//   ⚠ POSITION_CODE_TO_LABEL 을 그대로 쓰면 안 된다. 그쪽은 classLabel 어휘("정규")라, 상태 칩이나
//     "일반/크루" 로 분기하는 집계(loadTeamCurrentCrewByName)에 넣으면 어느 분기에도 안 걸려
//     그 사람이 집계에서 통째로 사라진다(2026-07-22 실측: [A] 정규6→4).
export function positionCodeToStatusLabel(code: string): string {
  switch (code) {
    case "regular":
      return "일반";
    case "advanced_agent":
      return "심화(에이전트)";
    case "advanced_part_leader":
      return "심화(파트장)";
    case "operating_team_leader":
      return "팀장";
    case "operating_ambassador":
      return "앰배서더";
    default:
      return "크루"; // operating_club_leader 등 — 크루 집계 대상 아님.
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 라벨 변환 **단일 진입점** — positionCode → statusLabel → classLabel
// ═══════════════════════════════════════════════════════════════════════════
// 종전에는 같은 변환이 4갈래로 흩어져 있었다:
//   memberStatusLabel(role, level) · classLabel(role, level) ·
//   positionCodeToStatusLabel(code) · POSITION_CODE_TO_LABEL[code]
// 소비처가 어느 쪽을 고르느냐에 따라 같은 사람이 다른 라벨을 받았고, 특히 어휘 2종을
//   섞으면 버킷 분기에서 통째로 사라졌다([[함정 1]] — [A] 정규6→4 실측).
//
// 앞으로 라벨이 필요한 모든 곳은 **이 함수 하나만** 호출한다. 파일마다 "일반"/"정규"/
//   "advanced_part_leader" 를 직접 비교하지 않는다.
//
//   · positionCode 를 알면(주차 effective/override) 그 코드가 진실이다.
//   · 모르면 role+membershipLevel 을 코드로 정규화해서 같은 경로를 탄다.
//   · 코드로 정규화조차 안 되는 값(관리자/최고 관리자, 신호 전무)만 종전 라벨러로 떨어진다.
export type PositionLabelBundle = {
  positionCode: PositionCode | null;
  /** 상태 칩·버킷 분기 어휘: 일반/심화(파트장)/심화(에이전트)/팀장/앰배서더/크루 */
  statusLabel: string;
  /** 클래스 컬럼 어휘: 정규/심화(파트장)/심화(에이전트)/운영진(팀장)/운영진(앰배서더) */
  classLabel: string;
};

export function resolvePositionLabels(input: {
  positionCode?: string | null;
  role?: string | null;
  membershipLevel?: string | null;
}): PositionLabelBundle {
  const role = input.role ?? null;
  const level = input.membershipLevel ?? null;
  const code = isPositionCode(input.positionCode)
    ? input.positionCode
    : roleLevelToPositionCode(role, level);
  if (code) {
    return {
      positionCode: code,
      statusLabel: positionCodeToStatusLabel(code),
      classLabel: POSITION_CODE_TO_CLASS_LABEL[code],
    };
  }
  // 코드 체계 밖(관리자/최고 관리자) 또는 신호 전무 — 종전 라벨러 유지.
  return {
    positionCode: null,
    statusLabel: memberStatusLabel(role, level),
    classLabel: classLabel(role, level),
  };
}

// ── 주차 이력 화면 전용 클래스 라벨 ────────────────────────────────────────────
// 특정 주차의 기록을 보여주는 화면(주차 상세·주차별 결과)은 **그 주차 effective position_code** 로만
//   클래스를 정한다. 현재 user_profiles.role 을 섞으면 과거 주차가 현재 직책으로 덮인다
//   (2026-07-22 정책: "현재 role 이 주차값을 덮으면 안 된다").
//   · 1순위: 카드의 crewClassPositionCode(주차 effective 코드) → positionCodeToClassLabel
//   · 2순위(구 스냅샷 호환): 주차 roleLabel 이 이미 클래스 어휘면 그대로, 아니면 role 없이 변환.
//     ⚠ 2순위에서도 role 은 절대 넘기지 않는다(누출 방지).
export function weekClassLabel(
  positionCode: string | null | undefined,
  weekRoleLabel: string | null | undefined,
): string {
  const byCode = positionCodeToClassLabel(positionCode);
  if (byCode) return byCode;
  const raw = (weekRoleLabel ?? "").trim();
  if (!raw) return "-";
  if (CLASS_LABEL_VALUES.has(raw)) return raw; // 이미 "정규"/"심화(파트장)"/"운영진(팀장)" 등
  // ⚠ role 은 넘기지 않는다(현재 직책 누출 방지) — 등급 라벨만으로 변환한다.
  return resolvePositionLabels({ membershipLevel: raw }).classLabel;
}

// 클래스 라벨 — memberStatusLabel(등급 SoT) → 정규/심화(파트장)/심화(에이전트)/운영진(앰배서더)/운영진(팀장).
// /admin/members 크루 목록 표(클래스 컬럼)와 크루 상세 페이지(클럽 소속 클래스)가 공유.
export function classLabel(role: string | null, level: string | null): string {
  const base = memberStatusLabel(role, level);
  switch (base) {
    case "팀장":
      return "운영진(팀장)";
    case "앰배서더":
      return "운영진(앰배서더)";
    case "심화(파트장)":
    case "심화(에이전트)":
      return base;
    case "일반":
    case "크루":
      return "정규";
    default:
      return base; // 관리자/최고 관리자 등(드묾)
  }
}

// 게이팅/임퍼소네이션용 정규화 역할. memberStatusLabel 단일 SoT 기반(라벨→역할 키).
//   team_leader(role=team_leader) · part_leader/agent(심화 등급) · 그 외=member.
export type NormalizedMemberRole = "team_leader" | "part_leader" | "agent" | "member";
export function normalizeMemberRole(
  role: string | null,
  membershipLevel: string | null,
): NormalizedMemberRole {
  const label = memberStatusLabel(role, membershipLevel);
  if (label === "팀장") return "team_leader";
  if (label === "심화(파트장)") return "part_leader";
  if (label === "심화(에이전트)") return "agent";
  return "member";
}

// 멤버 관리 UI/API 에서 지정 가능한 역할 4종.
// user_profiles.role CHECK(7종) 의 부분집합이며, ambassador/admin/super_admin 은
// 기존 시스템 보존용이라 이 화면에서는 다루지 않는다(노출/지정 모두 불가).
export const MEMBER_ASSIGNABLE_ROLES = [
  "crew", // 일반 멤버
  "agent",
  "part_leader",
  "team_leader",
] as const;
export type MemberAssignableRole = (typeof MEMBER_ASSIGNABLE_ROLES)[number];

export function isMemberAssignableRole(
  value: unknown,
): value is MemberAssignableRole {
  return (
    typeof value === "string" &&
    (MEMBER_ASSIGNABLE_ROLES as readonly string[]).includes(value)
  );
}

// 같은 파트/팀 안에서 최대 1명만 허용되는 역할 (유일성 검증 대상).
export const PART_UNIQUE_ROLES = ["agent", "part_leader"] as const;
export const TEAM_UNIQUE_ROLES = ["team_leader"] as const;

// 정렬 가능한 컬럼 whitelist. 임의 컬럼명을 그대로 order() 에 넘기지 않는다.
// check_points / advantage_points / penalty_points 는 user_profiles 컬럼이 아니라
// user_weekly_points 집계라서 DB .order() 로는 정렬할 수 없다. listMembers 가 이
// 키들을 별도 경로(전체 집계 후 메모리 정렬)로 처리한다.
export const MEMBER_SORT_COLUMNS = [
  "display_name",
  "contact_email",
  "auth_email",
  "organization_slug",
  "status",
  "growth_status",
  "check_points",
  "advantage_points",
  "penalty_points",
  "net_advantage_points",
  "created_at",
  "updated_at",
] as const;
export type MemberSortColumn = (typeof MEMBER_SORT_COLUMNS)[number];
export type MemberSortDir = "asc" | "desc";

export function isMemberSortColumn(value: string): value is MemberSortColumn {
  return (MEMBER_SORT_COLUMNS as readonly string[]).includes(value);
}

export type PresenceFilter = "has" | "missing";

export const ORG_NONE_SENTINEL = "__none__";

export const MEMBER_PATCH_FIELDS = [
  "organization_slug",
  "status",
  "growth_status",
  // 성장 중단 적용 주차(weeks.id) 또는 null(해제). UUID 검증은 pickMemberPatch 에서.
  "suspended_week_id",
  "contact_email",
  "contact_phone",
] as const;
export type MemberPatchField = (typeof MEMBER_PATCH_FIELDS)[number];

export type ListMembersOptions = {
  query?: string | null;
  organization?: string | null; // "__none__" 이면 organization_slug IS NULL
  status?: string | null;
  growthStatus?: string | null;
  authEmailPresence?: PresenceFilter | null;
  contactEmailPresence?: PresenceFilter | null;
  sortBy?: MemberSortColumn | null;
  sortDir?: MemberSortDir | null;
  limit?: number;
  offset?: number;
  // 모집단 모드(operating 기본=실사용자만·테스트 제외 / test=test_user_markers 만). 입력 옵션(응답 DTO 무변경).
  mode?: ScopeMode;
};

export type ListMembersResult = {
  members: AdminMemberDto[];
  total: number;
  withoutOrganizationCount: number;
  withoutAuthEmailCount: number;
  limit: number;
  offset: number;
};
