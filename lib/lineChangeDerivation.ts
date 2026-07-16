// 라인/대상자 변경 후 "파생 수렴" 공통 체인.
//
// 정본 저장 경로(adminCrewWeekLineSave.saveCrewWeekLineDetail §4~§5.5)가 하는 것과 "동일한" 파생
// 갱신을, 라인/대상자를 다른 문(door)으로 바꾸는 우회 경로에서도 재사용한다:
//   · 직접 target CRUD (adminCluster4LinesData.create/update/deleteCluster4LineTarget)
//   · 경험 라인 개설+평점 (adminExperienceTeamOverall.openTeamOverall / adminExperienceDraftData)
//
// ⚠ 새 계산식/재추정 금지 — 기존 공통 함수만 순서대로 조립한다:
//   1) 라인 A/B 원장 정합 + uwp 재집계 = reconcileLineAwardsForWeek(코호트=[user])
//        → 카드 enhancementStatus 를 SoT 로 라인마다 reconcileLineResultAwardForUser (성공=지급/비성공=회수).
//        → 대상자 해제로 카드에서 사라진 라인은 여기서 안 잡히므로, orphanLineId 지정 시 직접 회수.
//   2) uws 재판정 → snapshot 재생성 → 성장 통계 → 품계 = recomputeDerivedAfterActMutation
//        (액트 보완/취소·정본 라인 저장과 동일 composite).
//
// 순서 계약: (1) 이 (2) 앞 — uwp 최신값(earned=Point A)으로 uws 를 판정해야 하기 때문.
// 전부 best-effort(격리) — 실패해도 throw 하지 않는다(호출 응답 보호, cron/다음 저장에서 수렴).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { reconcileLineAwardsForWeek } from "@/lib/lineResultAwardReconcile";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { recomputeDerivedAfterActMutation } from "@/lib/crewWeekGrowthRejudge";

async function hasUserTargetOnLine(lineId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id")
    .eq("line_id", lineId)
    .eq("target_user_id", userId)
    .eq("target_mode", "user")
    .limit(1);
  return ((data ?? []) as Array<{ id: string }>).length > 0;
}

async function loadWeekStartDate(weekId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("weeks")
    .select("start_date")
    .eq("id", weekId)
    .maybeSingle();
  return (data as { start_date: string | null } | null)?.start_date ?? null;
}

// 한 주차의 지정 사용자들에 대해 정본과 동일한 파생 체인을 수렴한다.
//   orphanLineId: 대상자 해제가 가능한 경로(target CRUD)면 그 라인 id 를 넘긴다 —
//     해당 (user,line) 이 더 이상 대상자가 아니면 고아 지급을 직접 회수한다.
//     개설(additive) 경로는 생략(회수 없음).
export async function convergeLineChangeForUsers(params: {
  weekId: string;
  userIds: Array<string | null | undefined>;
  actor: string | null;
  orphanLineId?: string | null;
}): Promise<void> {
  const { weekId, actor } = params;
  const uniq = Array.from(new Set(params.userIds.filter((u): u is string => Boolean(u))));
  if (uniq.length === 0) return;
  const weekStartDate = await loadWeekStartDate(weekId);

  for (const userId of uniq) {
    // 1) 라인 A/B 원장 정합 + uwp 재집계 (배정 라인만 카드 SoT 로 재도출).
    try {
      if (weekStartDate) {
        await reconcileLineAwardsForWeek({
          weekId,
          weekStartDate,
          actor,
          cohortUserIds: [userId],
        });
      }
      // 배정 해제(대상자 삭제/이동)로 카드에서 사라진 라인은 위에서 처리되지 않는다 →
      //   그 (user,line) 지급을 직접 회수(reconcileLineResultAwardForUser 는 내부에서
      //   target 없음 → 회수). 지급 유지 라인이면 이 분기 자체를 건너뛴다.
      if (params.orphanLineId && !(await hasUserTargetOnLine(params.orphanLineId, userId))) {
        await reconcileLineResultAwardForUser(userId, params.orphanLineId, weekId, false, actor);
        await recomputeWeeklyPointsForUsers([userId], weekId);
      }
    } catch (e) {
      console.warn("[lineChangeDerivation] 라인 지급 정합 실패(격리)", {
        userId,
        weekId,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // 2) uws 재판정 → snapshot → 성장 통계 → 품계 (정본과 동일 composite).
    try {
      await recomputeDerivedAfterActMutation({ userId, weekId });
    } catch (e) {
      console.warn("[lineChangeDerivation] 파생 재계산 실패(best-effort)", {
        userId,
        weekId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
