// 주차 결과 "확정/확정 취소" 공통 서비스 — **서버 전용 단일 SoT**.
//
// 이 파일은 새 계산식·새 저장소를 만들지 않는다. 종전 `markTeamPartsWeekReviewed` /
//   `revertTeamPartsWeekReview`(lib/adminTeamPartsInfoWeekDetailData.ts)에 있던 확정 본체를
//   **그대로 옮겨온 것**이며, 두 소비자가 이 하나를 호출한다(로직 복제 금지):
//     ① 클럽 활동 검수(공표)  = publishCrewWeekResult (lib/crewWeekPublish.ts) — 정식 진입점
//     ② POST /api/admin/team-parts/info/weeks/[weekId]/review — 레거시 호환 래퍼(UI 제거됨)
//
// 확정(finalizeWeekResultCore) 단계와 데이터 의존성:
//   [1] finalizeWeekUws              → user_week_statuses 코호트 확정(성장 성공/실패 SoT)
//       ⚠ 반드시 최초 — 어드민 공표 snapshot(buildCrewResults)이 이 uws 를 **읽어서** 결과를 굳힌다.
//         확정 전에 snapshot 을 만들면 활동 0건 크루가 reasonCode="uws_missing" 으로 잘못 굳는다.
//   [2] markWeekResultPublished      → weeks.result_published_at (고객 앱 카드 tallying→success/fail 게이트)
//   [3] reconcileLineAwardsForWeek   → 라인 A/B 포인트 원장 정합 (⚠ snapshot 재계산 전 — 원장이 최신인 상태로 카드가 구워지게)
//   [4] recomputeCohortSnapshots     → 고객 앱 weekly-cards snapshot 코호트 단일 패스(c=8)
//   [5] recalcUserGrowthStatsForUsers→ user_growth_stats 누적/졸업
//   [6] markWeekResultReviewed       → weeks.result_reviewed_at
//   (+) setWeekOrgResultStatus       → cluster4_week_org_result_states: reviewing → published
//
// 멱등: 이미 공표된 주차 재실행 시 [2]~[4] 를 건너뛰고(코호트 전원 재계산 낭비 방지) uws 가 실제
//   바뀐 affected 만 보정한다. 원장은 reconcile(정합) 이라 재실행해도 중복 지급이 없고, 성장 통계는
//   원천 재계산(증분 누적 아님)이라 중복 누적이 없다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { OrganizationSlug } from "@/lib/organizations";
import type { StateScope } from "@/lib/operationalState";
import {
  markWeekResultPublished,
  markWeekResultReviewed,
  recomputeCohortSnapshots,
  resolveCohortUserIdsForScope,
  WeekResultPublishError,
  WeekResultReviewError,
} from "@/lib/adminWeekRecognitionsData";
import { reconcileLineAwardsForWeek } from "@/lib/lineResultAwardReconcile";
import { revertWeeklyCardFinalization } from "@/lib/adminWeeklyCardFinalizationData";
import {
  finalizeWeekUws,
  revertWeekUws,
  UwsFinalizeBlockedError,
  type FinalizeUwsResult,
} from "@/lib/adminWeekUwsFinalize";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { recalcUserGrowthStatsForUsers } from "@/lib/userGrowthStatsData";
import {
  setWeekOrgResultStatus,
  loadWeekOrgResultStates,
  resolveWeekOrgResultState,
  resolveOrgResultScope,
  type OrgResultScope,
  type WeekOrgResultStatus,
} from "@/lib/weekOrgResultState";

// 확정/취소의 사후 재계산(고객 snapshot·성장 캐시) 동시성 상한.
//   snapshot 1건 ≈ 5s(실측 2026-07-09) 라 코호트가 크면 concurrency 가 벽시계를 좌우한다.
//   lib DB 포화 가드 상한(8)과 동일 — 그 이상은 statement timeout/커넥션 포화 위험.
export const REVIEW_RECOMPUTE_CONCURRENCY = 8;

export class WeekResultFinalizeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WeekResultFinalizeError";
    this.status = status;
  }
}

// 확정 응답 — 이 주차가 최종 확정(공표+검수) 상태가 됐음을 알린다.
export type WeekResultFinalizeResult = {
  weekId: string;
  reviewed: true;
  reviewedAt: string;
  publishedAt: string;
  // 최초 실행 여부 구분(멱등 재실행 시 true) — 소비처가 "새로 확정"과 "이미 확정"을 구분할 수 있게.
  alreadyPublished: boolean;
  alreadyReviewed: boolean;
  // 코호트(그 주차 user_week_statuses 보유자) weekly-cards snapshot 재계산 결과.
  snapshotRecompute: { requested: number; recomputed: number; failed: number };
  // uws 확정 결과(2026-summer+ 운영 주차). 레거시/공식휴식/현재미래 주차는 skipped=true.
  uwsFinalize: FinalizeUwsResult | null;
};

export type WeekResultRevertResult = {
  weekId: string;
  reverted: boolean;
  publishedAt: string | null;
  reviewedAt: string | null;
  snapshotRecompute: { requested: number; recomputed: number; failed: number };
  uwsRevert: Awaited<ReturnType<typeof revertWeekUws>>;
};

/** 현재 조직 검수 상태(실패 시 원복용). 행이 없으면 레거시 폴백 판정을 그대로 쓴다. */
export async function loadOrgResultStatusForRestore(
  weekId: string,
  organization: OrganizationSlug,
  orgScope: OrgResultScope,
  weekStartDate: string,
  legacyReviewed: boolean,
): Promise<WeekOrgResultStatus> {
  const map = await loadWeekOrgResultStates([weekId], organization, orgScope);
  return resolveWeekOrgResultState(map.get(weekId), weekStartDate, legacyReviewed).status;
}

// ── 확정(공표+검수) ─────────────────────────────────────────────────────────
//
//   불변식:
//     - user_week_statuses.status(성장 성공/실패 SoT)는 [1] 이후 이 함수가 다시 건드리지 않는다 —
//       공표는 "표시 가능 상태"로 전환하는 이벤트일 뿐, 결과 판정 자체는 기존 계산 경로가 소유한다.
//     - operating SoT(weeks)만 쓴다(scope=qa 는 qa_weeks_state 오버레이) — 목록/상세의 주차 검수 V 가
//       weeks 를 직접 읽으므로 여기도 동일 저장소를 써야 새로고침 후 값이 유지된다.
export async function finalizeWeekResultCore(
  weekId: string,
  actor: string | null = null,
  opts: { scope?: StateScope; organization: OrganizationSlug; allowIncompleteTestData?: boolean },
): Promise<WeekResultFinalizeResult> {
  // scope: operating(기본, 실유저·운영 weeks) / qa(mode=test·테스트 코호트·qa_weeks_state).
  //   allowIncompleteTestData 는 finalizeWeekUws 내부에서 test/QA 스코프일 때만 안전장치를 bypass 한다.
  const scope: StateScope = opts.scope ?? "operating";
  // 검수 상태 저장 scope — finalize 코호트와 동일 규칙(QA/qa → test). 운영/테스트 상태는 독립 행.
  const orgScope: OrgResultScope = resolveOrgResultScope(scope);
  // 0) 주차 존재 + 현재 공표/검수 상태 + uws 확정에 필요한 메타.
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at",
    )
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekResultFinalizeError(500, wkErr.message);
  if (!wk) throw new WeekResultFinalizeError(404, "주차를 찾을 수 없습니다.");
  const week = wk as {
    id: string;
    start_date: string | null;
    end_date: string | null;
    season_key: string | null;
    iso_year: number | null;
    iso_week: number | null;
    is_official_rest: boolean | null;
    result_published_at: string | null;
    result_reviewed_at: string | null;
  };

  // 실패 시 되돌릴 직전 조직 상태(불완전 상태 잔존 방지). 읽기 실패는 무시(best-effort).
  let prevOrgStatus: WeekOrgResultStatus | null = null;
  try {
    prevOrgStatus = await loadOrgResultStatusForRestore(
      weekId,
      opts.organization,
      orgScope,
      week.start_date ?? "",
      week.result_reviewed_at != null,
    );
  } catch {
    prevOrgStatus = null;
  }
  const restoreOrgStatus = async () => {
    if (!prevOrgStatus) return;
    try {
      await setWeekOrgResultStatus(weekId, opts.organization, orgScope, prevOrgStatus, actor);
    } catch (e) {
      console.warn("[week-finalize] 조직 상태 원복 실패", {
        weekId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // [1] uws 확정 (공표 선행!) — 2026-summer+ 운영 주차의 코호트 verdict 를 user_week_statuses 로
  //   persist 한다. 레거시/공식휴식/현재·미래 주차는 내부에서 skip. 적립 미완료(전원 0점 fail 위험)·
  //   평가 미입력(pending) 이면 여기서 422 로 차단해 공표/검수를 진행하지 않는다(사고 방지).
  //   ⚠ 반드시 공표·snapshot 생성 전 — 어드민 공표 snapshot 과 고객 앱 카드가 **같은 확정 결과**를 읽어야 한다.
  await setWeekOrgResultStatus(weekId, opts.organization, orgScope, "reviewing", actor);
  let uwsFinalize: FinalizeUwsResult;
  try {
    uwsFinalize = await finalizeWeekUws(
      {
        id: week.id,
        start_date: week.start_date,
        end_date: week.end_date,
        season_key: week.season_key,
        iso_year: week.iso_year,
        iso_week: week.iso_week,
        is_official_rest: week.is_official_rest,
      },
      scope,
      actor,
      { allowIncompleteTestData: opts.allowIncompleteTestData, organization: opts.organization },
    );
  } catch (e) {
    // 차단(422)/예외 모두 조직 상태를 직전 값으로 되돌린다 — "검수 중"에 갇힌 불완전 상태 금지.
    await restoreOrgStatus();
    if (e instanceof UwsFinalizeBlockedError) {
      // 적립 미완료 / 평가 미입력 / 라인 미개설 mass-fail → 관리자 안내 후 중단(공표·검수 미실행).
      throw new WeekResultFinalizeError(e.status, e.message);
    }
    throw e;
  }

  // 현재/미래 주차 가드 (2026-07-09) — 진행 중인 주차는 확정 불가.
  //   finalizeWeekUws 가 current_or_future_week 로 skip 하면 uws 가 생기지 않는데(현재 주차는
  //   resolver 가 항상 running 으로 판정), 그대로 공표까지 진행하면 그 주차가 과거로 넘어가는 순간
  //   "published + uws 없음"이 되어 카드가 no_data 로 드롭되는 미래 사고를 예약하게 된다.
  //   → 여기서 명시 차단해 공표·검수를 실행하지 않는다(안내 후 종료). 레거시/공식휴식/빈 코호트
  //     skip 은 과거·유효 주차라 종전대로 공표 진행(카드 드롭 위험 없음 — uws 이관본/휴식 판정 존재).
  if (uwsFinalize.skipped && uwsFinalize.skipReason === "current_or_future_week") {
    await restoreOrgStatus();
    throw new WeekResultFinalizeError(
      422,
      "현재 진행 중인 주차는 아직 검수 완료할 수 없습니다. 주차가 종료된 후 검수 완료를 진행해주세요.",
    );
  }

  // [2] 공표(publish) — SoT 쓰기만 하고, 코호트 snapshot 재계산은 아래에서 "단일 패스"로 수행한다.
  //   ⚠ 이중 재계산 제거(2026-07-09 실측): 종전에는 publishWeekResult 가 코호트 전원을 c=3 로
  //     재계산하고, 곧바로 affected(코호트의 부분집합)를 c=8 로 다시 재계산 → 같은 85명을 두 번
  //     계산했다. 이제 공표 SoT 쓰기(markWeekResultPublished)와 코호트 재계산을 분리해,
  //     코호트 전원을 c=8 로 한 번만 재계산한다.
  await setWeekOrgResultStatus(weekId, opts.organization, orgScope, "published", actor);
  const alreadyPublished = week.result_published_at != null;
  let publishedAt = week.result_published_at;
  let snapshotRecompute = { requested: 0, recomputed: 0, failed: 0 };
  if (!alreadyPublished) {
    try {
      const pub = await markWeekResultPublished(weekId, scope, actor);
      publishedAt = pub.row.result_published_at ?? pub.nowIso;
    } catch (e) {
      if (e instanceof WeekResultPublishError) {
        // 409 = 그 사이 다른 요청이 공표함(race) → 최신 공표시각만 재조회하고 아래 단일 재계산으로 진행(멱등).
        if (e.status === 409) {
          const { data } = await supabaseAdmin
            .from("weeks").select("result_published_at").eq("id", weekId).maybeSingle();
          publishedAt = (data as { result_published_at: string | null } | null)?.result_published_at ?? publishedAt;
        } else {
          throw new WeekResultFinalizeError(e.status, e.message);
        }
      } else {
        throw e;
      }
    }
    // [3] 라인 결과 지급 정합(A/B) — publish/finalize 문(door)과 동일한 공통 SoT 안전망.
    //   확정 = 라인 강화 결과 최종 확정 시점이므로, 배정 라인의 성공→A/B 지급 / 비성공→회수 를
    //   원장에 한 번 더 정합화한다(멱등 · 별도 계산식 없음 = reconcileLineAwardsForWeek 재사용).
    //   ⚠ 반드시 snapshot 재계산 전 — 원장/포인트가 갱신된 상태로 카드가 구워지게. best-effort.
    //   (평상시 per-user 저장 시점 settle 로 orphan 0 이나, 우회 문으로 바뀐 라인의 예방용 안전망.)
    try {
      const reviewWeekStart = week.start_date;
      const cohortIds = reviewWeekStart
        ? await resolveCohortUserIdsForScope(reviewWeekStart, scope)
        : [];
      if (reviewWeekStart && cohortIds.length > 0) {
        await reconcileLineAwardsForWeek({
          weekId,
          weekStartDate: reviewWeekStart,
          actor,
          cohortUserIds: cohortIds,
        });
      }
    } catch (e) {
      console.warn("[week-finalize] line award reconcile 실패(확정 유지)", {
        weekId,
        message: e instanceof Error ? e.message : String(e),
      });
    }

    // [4] 단일 snapshot 패스: 그 주차 uws 보유자(=코호트) 전원을 c=8 로 한 번만 재계산한다.
    //   공표로 카드가 tallying→success/fail 로 굳으므로 코호트 전원 재계산이 필요하고,
    //   affectedUserIds(생성/갱신된 uws)는 이 코호트의 부분집합이라 별도 재계산이 불필요하다(이중 제거).
    //   best-effort — recomputeCohortSnapshots 는 내부에서 실패를 격리(카운트 반환)하고 throw 하지 않는다.
    snapshotRecompute = await recomputeCohortSnapshots(week.start_date, scope, {
      concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
      organization: opts.organization,
    });
  }
  // 이미 공표된 주차(재실행)는 위 단일 패스를 타지 않는다 — 성장 성공/실패 SoT(user_week_statuses)는
  //   확정으로 바뀌지 않으므로 코호트 전원 재계산이 불필요. 단, uws 가 실제 바뀐 affected 만 아래에서 보정.

  // 사후 캐시 재계산.
  //   - snapshot: 신규 공표(!alreadyPublished)면 위 단일 패스가 코호트 전원(affected 포함)을 이미
  //     재계산했으므로 여기서 재실행하지 않는다(이중 제거). 재실행(공표 스킵)일 때만, uws 가 실제
  //     바뀐 affected 를 재계산해 카드 정합을 맞춘다(공통 케이스는 affected 0 → no-op).
  //   - [5] user_growth_stats(누적/졸업): 공표/코호트 재계산 경로가 갱신하지 않으므로, uws 가 바뀐
  //     affected 사용자만 항상 재계산한다(저렴 — 유저당 1 SELECT+1 UPSERT · 원천 재계산이라 멱등).
  if (uwsFinalize.affectedUserIds.length > 0) {
    if (alreadyPublished) {
      try {
        await recomputeWeeklyCardsSnapshotsForUsers(uwsFinalize.affectedUserIds, {
          concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
        });
      } catch (e) {
        console.warn("[week-finalize] affected snapshot 재계산 실패(격리)", {
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // 성장 캐시 재계산 — 직렬 for-await(N×100ms 누적) 대신 제한 동시성 병렬(best-effort).
    await recalcUserGrowthStatsForUsers(uwsFinalize.affectedUserIds, {
      concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
    });
  }

  // [6] 검수 완료(reviewed) — 공표 선행 완료 상태에서 result_reviewed_at 세팅.
  const alreadyReviewed = week.result_reviewed_at != null;
  let reviewedAt = week.result_reviewed_at;
  if (!alreadyReviewed) {
    try {
      const rev = await markWeekResultReviewed(weekId, scope, actor);
      reviewedAt = rev.result_reviewed_at;
    } catch (e) {
      if (e instanceof WeekResultReviewError) {
        // 409 = 이미 검수됨(race) → 최신 값 재조회로 멱등 처리.
        if (e.status === 409) {
          const { data } = await supabaseAdmin
            .from("weeks").select("result_reviewed_at").eq("id", weekId).maybeSingle();
          reviewedAt = (data as { result_reviewed_at: string | null } | null)?.result_reviewed_at ?? reviewedAt;
        } else {
          throw new WeekResultFinalizeError(e.status, e.message);
        }
      } else {
        throw e;
      }
    }
  }

  return {
    weekId,
    reviewed: true,
    reviewedAt: reviewedAt ?? new Date().toISOString(),
    publishedAt: publishedAt ?? new Date().toISOString(),
    alreadyPublished,
    alreadyReviewed,
    snapshotRecompute,
    uwsFinalize,
  };
}

// ── 확정 취소 ───────────────────────────────────────────────────────────────
// finalizeWeekResultCore(공표+검수) 실행 직전 상태로 복원.
//   result_published_at=NULL + result_reviewed_at=NULL + 코호트 snapshot 재계산 → 카드 success/fail→tallying.
//   weekId → (season_key, week_number) 로 해석해 공용 revertWeeklyCardFinalization(rollback 로직)을 재사용한다.
//   scope: operating(기본)=운영 weeks · qa=qa_weeks_state 오버레이(테스트 코호트·안전 검증용).
//
// ⚠ 포인트 원장 정책: 롤백은 **기존 rollback 로직 그대로**다(새 정책 도입 금지). uws 를 되돌리면
//   그 주차 카드가 집계 중으로 복귀하고, 라인 A/B 원장은 다음 확정 시 reconcileLineAwardsForWeek 가
//   성공/비성공 기준으로 다시 정합화한다(회수 포함) — 여기서 원장을 별도로 지우지 않는다.
export async function revertWeekResultCore(
  weekId: string,
  scope: StateScope = "operating",
  actor: string | null = null,
  organization?: OrganizationSlug,
): Promise<WeekResultRevertResult> {
  const { data: wk, error: wkErr } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number")
    .eq("id", weekId)
    .maybeSingle();
  if (wkErr) throw new WeekResultFinalizeError(500, wkErr.message);
  const w = wk as { season_key: string | null; week_number: number | null } | null;
  if (!w?.season_key || w.week_number == null) {
    throw new WeekResultFinalizeError(404, "주차(season/weekNumber)를 찾을 수 없습니다.");
  }

  // 0) uws 확정 역연산 (확정이 생성/갱신한 uws 되돌리기) — 공표 해제보다 먼저.
  //   생성분 DELETE + 갱신분 prev_status 복원. run-log(cluster4_week_finalize_runs) provenance 기준.
  //   ⚠ revertWeeklyCardFinalization 의 코호트 재계산은 "현재 uws 보유자" 기준이라, 삭제된 uws 의
  //   사용자는 그 재계산에 안 잡힌다 → 아래에서 affected 를 명시 재계산해 카드가 skeleton/집계중으로 복귀.
  if (organization) {
    await setWeekOrgResultStatus(weekId, organization, resolveOrgResultScope(scope), "aggregating", actor);
  }
  const uwsRevert = await revertWeekUws(weekId, organization);

  // 1) 공용 rollback 로직 재사용(공표/검수 해제 + 코호트 재계산).
  const r = await revertWeeklyCardFinalization({
    seasonKey: w.season_key,
    weekNumber: w.week_number,
    org: organization ?? null,
    scope,
    actor,
  });

  // 2) 삭제/복원된 uws 사용자의 snapshot + 성장 캐시 재계산 (카드/누적 원복).
  //   revertWeekUws 가 uws 를 먼저 지우므로 revertWeeklyCardFinalization 의 코호트(=현재 uws 보유자)에는
  //   이들이 안 잡힌다 → 여기서 명시 재계산해야 카드가 집계중으로 복귀한다(이중 재계산 아님).
  //   snapshot 1건 ≈ 5s 라 코호트가 크면 여기가 벽시계를 지배 → 제한 동시성 병렬(3→8)로 단축.
  if (uwsRevert.affectedUserIds.length > 0) {
    try {
      await recomputeWeeklyCardsSnapshotsForUsers(uwsRevert.affectedUserIds, {
        concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
      });
    } catch (e) {
      console.warn("[week-finalize revert] affected snapshot 재계산 실패(격리)", {
        message: e instanceof Error ? e.message : String(e),
      });
    }
    // 성장 캐시 재계산 — 직렬 for-await 대신 제한 동시성 병렬(best-effort).
    await recalcUserGrowthStatsForUsers(uwsRevert.affectedUserIds, {
      concurrency: REVIEW_RECOMPUTE_CONCURRENCY,
    });
  }

  return {
    weekId,
    reverted: r.reverted || uwsRevert.reverted,
    publishedAt: r.published?.resultPublishedAt ?? null,
    reviewedAt: null,
    snapshotRecompute: r.snapshotRecompute,
    uwsRevert,
  };
}
