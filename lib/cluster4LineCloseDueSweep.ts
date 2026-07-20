// 라인 "2차 기입 마감(48h)" 자동 지급 스윕 — submission_closes_at 이 지난 라인의 강화 결과를 확정한다.
//
// 배경(2026-07-20): 라인 개설 시 submission_closes_at = 개설+48h 로 stamp 된다. 이 시각이 지나면
//   카드는 read 시 deadlinePassed 가 자동 true → info/competency 는 강화 성공으로 즉시 표시된다.
//   그러나 원장(process_point_awards)은 reconcile 실행이 있어야 갱신되므로, 48h 시점에 자동으로
//   결과를 확정·지급하는 스윕이 필요하다. 프로세스 체크 run-due 스윕([[project_process-check-run-due-endpoint]])과
//   동일한 외부 스케줄러(5~10분) + INTERNAL_API_KEY 패턴을 미러한다.
//
// 대상 허브 = info / competency 만. experience/career 는 성공이 평점 게이트에 종속되며, 평점 입력 훅
//   (adminExperienceLineSelect / adminCrewWeekLineSave)이 이미 그 시점에 reconcile 한다 — 마감만으로
//   즉시 지급되지 않으므로 스윕 대상에서 제외한다(마감만으로 무조건 성공 금지 정책과 일치).
//
// 멱등: finalizeLineResultAwards 는 원장 upsert(onConflict=source,ref_id,user_id) 라 재호출 무해.
//   result_finalized_at 마커로 확정 라인을 재처리에서 제외해 매 폴링 재계산을 막는다(성능 최적화이지
//   정합 전제가 아님 — 마커 미적용/누락이어도 이중지급은 없다). 스윕이 놓친 라인은 주차 공표에서 반드시 지급.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { finalizeLineResultAwards, type LineFinalizeResult } from "@/lib/lineResultAwardReconcile";

// 스윕 대상 허브 — 마감(deadline)만으로 성공이 확정되는 허브.
const SWEEP_HUBS = ["info", "competency"] as const;

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

// 마감이 지난 info/competency 라인의 강화 결과를 확정·지급한다.
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
