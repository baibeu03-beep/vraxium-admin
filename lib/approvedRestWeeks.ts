import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";

// ─────────────────────────────────────────────────────────────────────
// 승인된 개인 휴식 주차 — 공통 SoT loader.
//
// SoT = `vacation_requests` (status='approved'). "특정 사용자 × 조직 × 시즌/주차의
//   승인된 휴식 상태" 를 조회하는 유일한 공통 데이터 계층이다. 페이지·판정 로직이
//   각자 vacation_requests 를 다시 계산하지 말고 이 loader 를 호출해야 한다.
//
// 키: `week_start_date`(월요일 ISO YYYY-MM-DD). 모든 캘린더/휴식 규칙이 날짜로 판정하며
//   (isSeasonRuleRestForWeekStart·hasWeekStartedKst 등), cluster4 주차 카드의 startDate 와
//   동일하다. `week_id`(weeks.id uuid) 는 FK/조인용으로 함께 실어 내려준다(front /api/profile
//   restWeekIds 처럼 week_id 로 조인하는 소비자 대응).
//
// 정책(사용자 확정):
//   · `approved` 만 휴식 승인으로 처리. pending/rejected/cancelled 는 휴식 아님.
//   · 신규 휴식 승인의 SoT 는 항상 vacation_requests. 기존 user_week_statuses.status=
//     'personal_rest' 레거시 값과의 union 은 판정 코어(getUwsStatus)에서 이미 처리되므로,
//     이 loader 는 vacation_requests 만 읽는다(중복 조회/이중 SoT 방지).
//   · request_type(정상/긴급)은 표시용 부가 정보. 승인 여부(status)와 무관한 별개 축.
//
// mode(operating/test)·demoUserId·actAsTestUserId 는 이 loader 를 바꾸지 않는다 — 호출부가
//   결정한 userId 만 다르고, 그 이후 조회/판정은 전부 동일하다(입구만 다르고 이후 동일).
// ─────────────────────────────────────────────────────────────────────

export type RestApprovalStatus =
  | "approved"
  | "pending"
  | "rejected"
  | "cancelled";

export type RestType = "normal" | "urgent";

// 사용자×주차 휴식 상태 공통 DTO. 같은 상태를 페이지별로 다른 필드명으로 만들지 않는다.
export type UserWeekRestStatus = {
  weekStartDate: string; // 월요일 ISO — 판정/조인 키
  weekId: string | null; // weeks.id (uuid) — FK, 레거시 행은 null 가능
  seasonKey: string | null;
  isRestApproved: boolean; // approvalStatus === "approved"
  restType: RestType | null;
  approvalStatus: RestApprovalStatus | null;
};

type VacationRestRow = {
  week_id: string | null;
  week_start_date: string | null;
  season_key: string | null;
  status: string | null;
  request_type?: string | null;
};

function isMissingColumn(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "42703"
  );
}

function normalizeStatus(raw: string | null): RestApprovalStatus | null {
  switch (raw) {
    case "approved":
    case "pending":
    case "rejected":
    case "cancelled":
      return raw;
    default:
      return null;
  }
}

function normalizeType(raw: string | null | undefined): RestType | null {
  return raw === "urgent" ? "urgent" : raw === "normal" ? "normal" : null;
}

// vacation_requests(승인) 행 조회 — request_type 미적용(42703) 환경 폴백 포함.
//   userId 필수. org/seasonKey 는 있으면 스코프(조직 격리·시즌 필터).
async function fetchApprovedRows(opts: {
  userId: string;
  organizationSlug?: OrganizationSlug | null;
  seasonKey?: string | null;
}): Promise<VacationRestRow[]> {
  const { userId, organizationSlug, seasonKey } = opts;
  const build = (withType: boolean) => {
    const cols = withType
      ? "week_id,week_start_date,season_key,status,request_type"
      : "week_id,week_start_date,season_key,status";
    let q = supabaseAdmin
      .from("vacation_requests")
      .select(cols)
      .eq("user_id", userId)
      .eq("status", "approved");
    if (organizationSlug) q = q.eq("org", organizationSlug);
    if (seasonKey) q = q.eq("season_key", seasonKey);
    return q;
  };

  let res = await build(true);
  if (res.error && isMissingColumn(res.error)) {
    // request_type 컬럼 미적용(2026-07-09 마이그레이션 전) → 타입 없이 재조회(전부 normal 폴백).
    res = await build(false);
  }
  if (res.error) {
    throw Object.assign(new Error(res.error.message), {
      code: (res.error as { code?: string }).code,
    });
  }
  return (res.data ?? []) as unknown as VacationRestRow[];
}

function toDto(row: VacationRestRow): UserWeekRestStatus | null {
  if (!row.week_start_date) return null;
  const approvalStatus = normalizeStatus(row.status);
  return {
    weekStartDate: row.week_start_date,
    weekId: row.week_id ?? null,
    seasonKey: row.season_key ?? null,
    isRestApproved: approvalStatus === "approved",
    restType: normalizeType(row.request_type),
    approvalStatus,
  };
}

// 승인된 개인 휴식 주차 목록(공통 DTO). userId 기준, org/season 스코프 선택.
export async function getApprovedRestWeeks(opts: {
  userId: string;
  organizationSlug?: OrganizationSlug | null;
  seasonKey?: string | null;
}): Promise<UserWeekRestStatus[]> {
  const rows = await fetchApprovedRows(opts);
  const out: UserWeekRestStatus[] = [];
  for (const r of rows) {
    const dto = toDto(r);
    if (dto) out.push(dto);
  }
  return out;
}

// 승인된 휴식 주차 시작일(week_start_date) 집합 — 판정 코어 주입용 키.
export async function getApprovedRestWeekStarts(opts: {
  userId: string;
  organizationSlug?: OrganizationSlug | null;
  seasonKey?: string | null;
}): Promise<Set<string>> {
  const rows = await fetchApprovedRows(opts);
  const set = new Set<string>();
  for (const r of rows) if (r.week_start_date) set.add(r.week_start_date);
  return set;
}

// 승인된 휴식 주차의 weeks.id(uuid) 집합 — week_id 로 조인하는 소비자(front /api/profile
//   restWeekIds)용. week_id 가 null 인 레거시 행은 제외된다.
export async function getApprovedRestWeekIds(opts: {
  userId: string;
  organizationSlug?: OrganizationSlug | null;
  seasonKey?: string | null;
}): Promise<Set<string>> {
  const rows = await fetchApprovedRows(opts);
  const set = new Set<string>();
  for (const r of rows) if (r.week_id) set.add(r.week_id);
  return set;
}

// 단일 사용자×주차 휴식 상태(없으면 null). 포인트/게이트 판정 등 단건 조회용.
export async function getUserWeekRestStatus(opts: {
  userId: string;
  organizationSlug?: OrganizationSlug | null;
  weekStartDate: string;
}): Promise<UserWeekRestStatus | null> {
  const rows = await getApprovedRestWeeks({
    userId: opts.userId,
    organizationSlug: opts.organizationSlug,
  });
  return rows.find((r) => r.weekStartDate === opts.weekStartDate) ?? null;
}
