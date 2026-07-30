// 라인 "2차 기입 마감(48h)" 자동 지급 스윕 — submission_closes_at 이 지난 라인의 강화 결과를 확정한다.
//
// 배경(2026-07-20 도입, 2026-07-30 허브 공통 정책으로 리팩터링): 라인 개설 시 submission_closes_at =
//   개설+48h 로 stamp 된다. 이 시각이 지나면 카드는 read 시 deadlinePassed 가 자동 true 가 되어
//   화면(강화 상태)은 즉시 바뀐다. 그러나 원장(process_point_awards)은 reconcile 실행이 있어야
//   갱신되므로, 마감 시점에 자동으로 결과를 확정·지급하는 스윕이 필요하다. 프로세스 체크 run-due
//   스윕([[project_process-check-run-due-endpoint]])과 동일한 외부 스케줄러(5~10분) + INTERNAL_API_KEY
//   패턴을 미러한다.
//
// ── 지급 판정 = 단일 기준(2026-07-30 확정) ──────────────────────────────────────────────
//   "지금 이 (user, line) 의 강화 상태가 computeCluster4Enhancement() 로 success 인가?" 하나뿐이다.
//   허브별로 지급 타이밍이나 success 조건을 따로 구현하지 않는다 — info/competency 는 대상자+마감만
//   보면 되고, experience 는 평점 게이트, career 는 등급 게이트가 있지만 그 판정은 전부
//   computeCluster4Enhancement() 안에 있다. 이 스윕은 그 결과(카드의 line.enhancementStatus,
//   finalizeLineResultAwards → reconcileLineAwardsForWeek 가 SoT 로 읽는다)를 재확인해서
//   success 면 지급, pending/fail/not_applicable 이면 지급하지 않을 뿐이다.
//
//   ⚠ 과거(2026-07-20~2026-07-30)엔 대상 허브를 info/competency 로만 한정했었다 — "experience/career 는
//   평점 입력 훅이 이미 그 시점에 reconcile 한다"는 전제였는데, 실제로는 평점이 **마감 전에** 입력되는
//   경우가 대부분이라 그 시점의 reconcile 은 (deadlinePassed=false 라 정확하게) pending 판정으로
//   지급을 보류한다 — 그 뒤 마감이 지나도 재확인하는 장치가 없어 지급이 영구 누락됐다(실사례:
//   2026-summer W4 experience 라인, 평점 7·강화 성공 표시인데 Point A/B·평점 원장 0건). 이번 리팩터로
//   4허브 전부 이 스윕이 재확인하므로 "허브마다 지급 시점이 다르다" 는 전제 자체가 사라진다.
//
// 멱등: finalizeLineResultAwards 는 원장 upsert(onConflict=source,ref_id,user_id) 라 재호출 무해.
//   result_finalized_at 마커로 확정 라인을 재처리에서 제외해 매 폴링 재계산을 막는다(성능 최적화이지
//   정합 전제가 아님 — 마커 미적용/누락이어도 이중지급은 없다). 단, 재확인 결과가 여전히 pending
//   (예: 마감은 지났지만 experience 평점이 아직 입력되지 않음)이면 확정 마킹을 보류해 다음 폴링에서
//   다시 확인한다(finalizeLineResultAwards 의 stillPending 참고) — pending 을 "처리 끝"으로 착각해
//   평점이 나중에 들어와도 영원히 재확인하지 않는 사고를 막는다. 스윕이 놓친 라인은 주차 공표에서 반드시 지급.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { finalizeLineResultAwards, type LineFinalizeResult } from "@/lib/lineResultAwardReconcile";

// 스윕 대상 허브 — 4허브 전부(정보/경험/역량/경력). success 판정은 전부 computeCluster4Enhancement()
//   하나로 통일돼 있으므로(finalizeLineResultAwards → reconcileLineAwardsForWeek 경유) 허브를 가려
//   제외할 이유가 없다.
const SWEEP_HUBS = ["info", "experience", "competency", "career"] as const;

// 마커 컬럼 미적용(마이그레이션 전) 폴백 시 사용할 catch-up 조회 창(마감 후 이 기간 내 라인만 후보).
//   마커가 있으면 무제한(미확정 전부)이지만, 폴백 경로는 재처리 폭주를 막기 위해 최근 창으로 제한한다.
const FALLBACK_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000; // 3일

const DEFAULT_MAX_ITEMS = 25;

export type LineCloseDueSweepResult = {
  found: number; // 마감 후보로 발견된 라인 수(capped 전)
  processed: number; // finalize 실행한 라인 수
  capped: boolean; // maxItems 초과로 다음 폴링에 넘긴 라인이 있는가
  results: LineFinalizeResult[];
  usedFallback: boolean; // result_finalized_at 마커 없이 폴백 조회를 썼는가
};

type DueLineRow = { id: string; submission_closes_at: string | null };

async function findDueLineIds(
  nowIso: string,
  limit: number,
): Promise<{ ids: string[]; usedFallback: boolean }> {
  // 1차: 마커 기반(활성 + 미확정 + 마감 지남). 결과는 마감이 오래된 순.
  const primary = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at")
    .in("part_type", SWEEP_HUBS as unknown as string[])
    .eq("is_active", true)
    .is("result_finalized_at", null)
    .lte("submission_closes_at", nowIso)
    .order("submission_closes_at", { ascending: true })
    .limit(limit);

  if (!primary.error) {
    return {
      ids: ((primary.data ?? []) as DueLineRow[]).map((r) => r.id),
      usedFallback: false,
    };
  }

  // result_finalized_at 컬럼 미적용(42703/PGRST204) → 최근 창 폴백(재처리는 늘지만 정합 유지).
  const missingCol =
    primary.error.code === "42703" ||
    primary.error.code === "PGRST204" ||
    /result_finalized_at|schema cache/i.test(primary.error.message ?? "");
  if (!missingCol) {
    throw new Error(primary.error.message);
  }

  const sinceIso = new Date(Date.now() - FALLBACK_LOOKBACK_MS).toISOString();
  const fallback = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,submission_closes_at")
    .in("part_type", SWEEP_HUBS as unknown as string[])
    .eq("is_active", true)
    .lte("submission_closes_at", nowIso)
    .gte("submission_closes_at", sinceIso)
    .order("submission_closes_at", { ascending: true })
    .limit(limit);
  if (fallback.error) throw new Error(fallback.error.message);
  return {
    ids: ((fallback.data ?? []) as DueLineRow[]).map((r) => r.id),
    usedFallback: true,
  };
}

// 마감이 지난 4허브 라인의 강화 결과를 확정·지급한다(success 판정은 computeCluster4Enhancement 단일 SoT).
//   onlyLineIds 지정 시 그 라인만(관리자 수동 재실행/검증용). maxItems 초과분은 capped→다음 폴링 catch-up.
export async function runDueLineCloseSweep(
  params: { maxItems?: number; onlyLineIds?: string[]; actor?: string | null } = {},
): Promise<LineCloseDueSweepResult> {
  const maxItems = Math.max(1, params.maxItems ?? DEFAULT_MAX_ITEMS);
  const actor = params.actor ?? null;
  const nowIso = new Date().toISOString();

  let candidateIds: string[];
  let usedFallback = false;
  if (params.onlyLineIds && params.onlyLineIds.length > 0) {
    candidateIds = Array.from(new Set(params.onlyLineIds));
  } else {
    const found = await findDueLineIds(nowIso, maxItems + 1);
    candidateIds = found.ids;
    usedFallback = found.usedFallback;
  }

  const capped = candidateIds.length > maxItems;
  const toProcess = candidateIds.slice(0, maxItems);

  const results: LineFinalizeResult[] = [];
  for (const lineId of toProcess) {
    try {
      results.push(await finalizeLineResultAwards({ lineId, actor }));
    } catch (e) {
      console.warn("[lineCloseDueSweep] finalize failed (isolated)", {
        lineId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    found: candidateIds.length,
    processed: results.length,
    capped,
    results,
    usedFallback,
  };
}
