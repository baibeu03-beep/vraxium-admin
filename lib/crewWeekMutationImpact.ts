import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { adminWeekStatusLabel } from "@/lib/adminCrewWeeklyResults";
import type { OrganizationSlug } from "@/lib/organizations";

// ─────────────────────────────────────────────────────────────────────
// 액트 보완/취소가 "그 크루·그 주차"의 성장 결과(성공/실패)를 바꾸는지 원장 쓰기 없이 미리 계산한다.
//   · 보완/취소 공통 계산기 — 저장 전 확인 팝업 판단(성장 결과 flip)과 커밋 시 재검증에 함께 쓴다.
//   · 성장 결과 판정은 predictWeekStatusForUser(= 커밋 rejudge 와 동일 순수 로직)를 earnedOverride 로
//     호출 → "미리보기 == 실제 결과" 파리티. 새 판정 공식 없음.
//   · 표시는 성장 결과(+ Point A 전후)만. 품계·위클리 랭킹은 팝업에서 제외(커밋 후 재계산·반영은 유지).
//   · Point A 만 주차 성공 게이트에 영향(B/C 무관). 보완=+pointA, 취소=−Σ(취소 대상 point_check).
// ─────────────────────────────────────────────────────────────────────

export type CrewWeekMutation =
  | { kind: "supplement"; pointA: number; pointB: number; pointC: number }
  | { kind: "cancel"; awardIds: string[] };

type Side = {
  growthStatus: string; // success | fail | personal_rest | official_rest
  growthStatusLabel: string; // "성장 성공" | "성장 실패" | …
  pointA: number; // 그 주차 별(A) 총합
};

export type CrewWeekMutationImpact = {
  growthStatusChanged: boolean; // 성장 결과(성공/실패)가 바뀌는가
  confirmationRequired: boolean; // = growthStatusChanged (확인 팝업 필요 여부)
  before: Side;
  after: Side;
};

const GROWTH_CODES = new Set(["success", "fail"]);

const side = (growthStatus: string, pointA: number): Side => ({
  growthStatus,
  growthStatusLabel: adminWeekStatusLabel(growthStatus),
  pointA,
});

// 그 주차(weekId)의 현재 Point A 총합(user_weekly_points.points, 행 없으면 0).
async function fetchCurrentPointA(userId: string, weekId: string): Promise<number> {
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("iso_year,iso_week")
    .eq("id", weekId)
    .maybeSingle();
  const w = wk as { iso_year: number | null; iso_week: number | null } | null;
  if (!w || w.iso_year == null || w.iso_week == null) return 0;
  const { data } = await supabaseAdmin
    .from("user_weekly_points")
    .select("points")
    .eq("user_id", userId)
    .eq("year", w.iso_year)
    .eq("week_number", w.iso_week)
    .maybeSingle();
  return (data as { points: number } | null)?.points ?? 0;
}

// 취소 대상 원장 행들의 Point A(point_check) 합 — 그 크루 소유 + 미취소 행만.
async function fetchCancelPointADelta(userId: string, awardIds: string[]): Promise<number> {
  const ids = Array.from(new Set(awardIds)).filter((v) => typeof v === "string" && v);
  if (ids.length === 0) return 0;
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("point_check,user_id,cancelled_at")
    .in("id", ids);
  const rows = (data ?? []) as { point_check: number | null; user_id: string; cancelled_at: string | null }[];
  return rows
    .filter((r) => r.user_id === userId && !r.cancelled_at)
    .reduce((s, r) => s + (r.point_check || 0), 0);
}

// 보완/취소가 성장 결과를 바꾸는지 미리 계산(side-effect 없음).
export async function previewCrewWeekMutationImpact(params: {
  userId: string;
  weekId: string;
  organizationSlug: OrganizationSlug | null;
  currentStatus: string; // ctx.card.userWeekStatus (현재 관리자가 보는 성장 결과)
  mutation: CrewWeekMutation;
}): Promise<CrewWeekMutationImpact> {
  const { userId, weekId, organizationSlug, currentStatus, mutation } = params;

  const earnedBefore = await fetchCurrentPointA(userId, weekId);
  let delta = 0;
  if (mutation.kind === "supplement") {
    delta = mutation.pointA; // A/B ⇄ C 상호배타(상위 검증) — pointC 모드면 pointA=0.
  } else {
    delta = -(await fetchCancelPointADelta(userId, mutation.awardIds));
  }
  const earnedAfter = Math.max(0, earnedBefore + delta);

  // after 성장 결과 = earnedAfter 기준 판정(커밋과 동일 로직). skip/휴식/레거시 → 현재 상태 유지.
  const pred = await predictWeekStatusForUser({
    userId,
    weekId,
    organizationSlug,
    earnedOverride: earnedAfter,
  });
  const afterStatus =
    !pred.skipped && pred.targetStatus ? pred.targetStatus : currentStatus;

  const growthStatusChanged =
    GROWTH_CODES.has(currentStatus) &&
    GROWTH_CODES.has(afterStatus) &&
    currentStatus !== afterStatus;

  return {
    growthStatusChanged,
    confirmationRequired: growthStatusChanged,
    before: side(currentStatus, earnedBefore),
    after: side(afterStatus, earnedAfter),
  };
}
