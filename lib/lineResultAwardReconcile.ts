// 라인 강화 결과 지급(Point A/B) — 주차 코호트 정합화 (공표/집계 확정 경로 공용).
//
// 정책(2026-07 확정): 라인 Point A/B 는 "라인 개설 시 지급"이 아니라 "강화 성공 시 지급"이다.
//   · 배정된(lineTargetId) 라인의 결과가 강화 성공 → A/B 지급
//   · 실패/해당없음/비대상 → 회수(soft-cancel)
//   · 지급/회수 단위 규칙·멱등은 reconcileLineResultAwardForUser 한 곳(관리자 수동 저장과 동일 SoT).
//
// 이 모듈은 그 규칙을 "주차 전원"에 일괄 적용한다. 각 사용자의 그 주차 카드(resolveCrewWeekCard)를
// enhancementStatus SoT 로 삼아(재추정 금지) 배정 라인마다 reconcile 한다.
//   · settle(포인트 재합산)은 이 모듈이 recomputeWeeklyPointsForUsers 로 수행한다.
//   · snapshot 재계산은 호출부(publishWeekResult → recomputeCohortSnapshots)가 이어서 수행한다.
//
// ⚠ 순환 import 회피: 이 모듈은 resolveCrewWeekCard(adminCrewWeekDetail) + processPointAccrual 를
//   import 하지만, 두 모듈은 이 모듈을 import 하지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { mapWithConcurrency, GROWTH_CARD_CONCURRENCY } from "@/lib/concurrency";

export type LineAwardReconcileSummary = {
  weekId: string;
  cohortUsers: number; // 코호트 중 배정 라인 보유자 수(카드 로드 대상)
  reconciledLines: number; // reconcile 호출한 (user,line) 수
  paid: number; // 성공 → 지급으로 원장이 활성화된 라인 수
  revoked: number; // 비성공/비대상 → 회수된 라인 수
  changedUserIds: string[]; // 포인트 재합산이 필요한 user 집합
  failedUsers: number; // 카드 로드/ reconcile 실패한 user 수(격리)
};

// 특정 (user,line) 의 현재 활성 라인 지급 원장(source='line') 유무.
async function hasActiveLineAward(userId: string, lineId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("point_check,point_advantage,cancelled_at")
    .eq("source", "line")
    .eq("ref_id", lineId)
    .eq("user_id", userId)
    .maybeSingle();
  const row = data as
    | { point_check: number | null; point_advantage: number | null; cancelled_at: string | null }
    | null;
  if (!row) return false;
  if (row.cancelled_at) return false;
  return (row.point_check ?? 0) > 0 || (row.point_advantage ?? 0) > 0;
}

// 주차 코호트 = user_week_statuses.week_start_date 보유자. scope 필터는 호출부가 이미 반영한
//   userIds 를 넘기거나(권장), 넘기지 않으면 weekStartDate 로 전원 조회한다.
async function resolveCohortUserIds(weekStartDate: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .eq("week_start_date", weekStartDate);
  return Array.from(new Set(((data ?? []) as { user_id: string }[]).map((r) => r.user_id)));
}

// 그 주차에 배정(target_mode='user') 이력이 있는 user 집합 — 카드 로드 대상 축소용.
async function resolveTargetedUserIds(weekId: string): Promise<Set<string>> {
  const { data } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("week_id", weekId)
    .eq("target_mode", "user")
    .not("target_user_id", "is", null);
  return new Set(((data ?? []) as { target_user_id: string }[]).map((r) => r.target_user_id));
}

// 주차 전원의 라인 결과 지급을 정합화한다. dryRun=true 면 원장을 쓰지 않고 델타만 계산한다.
export async function reconcileLineAwardsForWeek(params: {
  weekId: string;
  weekStartDate: string;
  actor: string | null;
  cohortUserIds?: string[]; // scope-filtered 코호트(없으면 weekStartDate 로 전원)
  dryRun?: boolean;
  concurrency?: number;
}): Promise<LineAwardReconcileSummary> {
  const { weekId, weekStartDate, actor, dryRun = false } = params;
  const cohort = params.cohortUserIds ?? (await resolveCohortUserIds(weekStartDate));
  const targeted = await resolveTargetedUserIds(weekId);
  const users = cohort.filter((u) => targeted.has(u));

  // touched = 배정 라인을 1건이라도 reconcile 한 user. reconcileLineResultAwardForUser 는
  //   성공 시 crew-org config 값으로 원장을 항상 upsert(갱신) 하므로, "존재 플립" 이 없어도
  //   지급액(point_check/advantage)이 config 변경으로 달라질 수 있다. 따라서 값 변화까지 반영하려면
  //   존재 플립만 재합산 대상으로 삼으면 안 된다 → touched 전원을 재합산한다(멱등·안전).
  const touched = new Set<string>();
  let reconciledLines = 0;
  let paid = 0;
  let revoked = 0;
  let failedUsers = 0;

  await mapWithConcurrency(users, params.concurrency ?? GROWTH_CARD_CONCURRENCY, async (userId) => {
    try {
      const resolved = await resolveCrewWeekCard(userId, weekId);
      if (!resolved.ok) return;
      for (const line of resolved.card.lines) {
        if (line.lineId == null || line.lineTargetId == null) continue; // 배정 라인만
        const desiredSuccess = line.enhancementStatus === "success";
        const before = await hasActiveLineAward(userId, line.lineId);
        reconciledLines += 1;
        touched.add(userId);
        if (desiredSuccess && !before) paid += 1;
        if (!desiredSuccess && before) revoked += 1;
        if (!dryRun) {
          await reconcileLineResultAwardForUser(userId, line.lineId, weekId, desiredSuccess, actor);
        }
      }
    } catch (e) {
      failedUsers += 1;
      console.warn("[lineResultAwardReconcile] user reconcile failed (isolated)", {
        weekId,
        userId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // 배정 라인을 reconcile 한 user 전원 포인트 재합산(멱등) — 값 갱신까지 uwp 에 반영. dryRun 은 쓰지 않는다.
  const changedUserIds = Array.from(touched);
  if (!dryRun && changedUserIds.length > 0) {
    await recomputeWeeklyPointsForUsers(changedUserIds, weekId);
  }

  return {
    weekId,
    cohortUsers: users.length,
    reconciledLines,
    paid,
    revoked,
    changedUserIds,
    failedUsers,
  };
}
