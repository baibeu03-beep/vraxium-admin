// 회원 표시 성장상태(GrowthStatusKey) → 상태 버킷/라벨 — 단일 SoT(browser-safe, DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────
// /admin/members 크루 목록 표(상태 컬럼·필터)와 크루 상세 페이지(클럽 소속 상태)가
// 동일 매핑을 공유한다. 한 함수가 라벨과 버킷을 함께 구동해 정합을 보장한다.
//   활동 중 = active+extra_growth · 시즌 휴식 = seasonal_rest+official_rest(공식 휴식 포함)
//   주차 휴식 = weekly_rest · 활동 중단 = suspended+paused · 바사노스 = graduating(졸업 절차)
//   엘리트 = graduated · 온보딩 = onboarding · 그 외/미상 = -
// ─────────────────────────────────────────────────────────────────────

export type MemberStatusBucket =
  | "active"
  | "elite"
  | "seasonal_rest"
  | "weekly_rest"
  | "suspended"
  | "onboarding"
  | "basanos"
  | "none";

export function statusBucket(key: string | null): MemberStatusBucket {
  switch (key) {
    case "active":
    case "extra_growth":
      return "active";
    case "graduated":
      return "elite";
    case "seasonal_rest":
    case "official_rest":
      return "seasonal_rest";
    case "weekly_rest":
      return "weekly_rest";
    case "suspended":
    case "paused":
      return "suspended";
    case "onboarding":
      return "onboarding";
    case "graduating":
      return "basanos";
    default:
      return "none";
  }
}

export const BUCKET_LABEL: Record<MemberStatusBucket, string> = {
  active: "활동 중",
  elite: "엘리트",
  seasonal_rest: "시즌 휴식",
  weekly_rest: "주차 휴식",
  suspended: "활동 중단",
  onboarding: "온보딩",
  basanos: "바사노스",
  none: "-",
};

// 표시 성장상태 키 → 상태 라벨(버킷 라벨). 미상/null → "-".
export function statusBucketLabel(key: string | null): string {
  return BUCKET_LABEL[statusBucket(key)];
}
