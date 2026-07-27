// 회원 표시 성장상태(GrowthStatusKey) → 상태 버킷/라벨 — 단일 SoT(browser-safe, DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────
// /admin/members 크루 목록 표(상태 컬럼·필터)와 크루 상세 페이지(클럽 소속 상태)가
// 동일 매핑을 공유한다. 한 함수가 라벨과 버킷을 함께 구동해 정합을 보장한다.
//   활동 중 = active+extra_growth · 시즌 휴식 = seasonal_rest · 공식 휴식 = official_rest
//   주차 휴식 = weekly_rest · 활동 중단 = suspended+paused · 바사노스 = graduating(졸업 절차)
//   엘리트 = graduated · 온보딩 = onboarding · 그 외/미상 = -
//
// ⚠ 2026-07-27 정정 — **공식 휴식(official_rest)을 시즌 휴식에서 분리**했다.
//   official_rest 는 user_week_statuses 의 **주차** 상태(그 주 공식 휴식)이고,
//   시즌 휴식은 user_season_statuses.status='rest' 의 **시즌** 상태다. 서로 다른 개념인데
//   같은 버킷으로 묶여 있어서 집합 필터(클러빙_축소)가 공식 휴식자까지 함께 빼고 있었다.
//   확정 정책: 클러빙_축소 = 클러빙_확대 − 바사노스 − **시즌 휴식**.
//   공식 휴식자는 그 시즌 활동 대상이므로 클러빙_축소에 남고, 상태만 별도 라벨로 표시한다.
// ─────────────────────────────────────────────────────────────────────

export type MemberStatusBucket =
  | "active"
  | "elite"
  | "seasonal_rest"
  | "official_rest"
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
      return "seasonal_rest";
    case "official_rest":
      return "official_rest"; // 주차 단위 공식 휴식 — 시즌 휴식과 다른 개념(집합 필터에서 분리).
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
  official_rest: "공식 휴식",
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
