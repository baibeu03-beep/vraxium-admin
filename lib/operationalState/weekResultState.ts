// ─────────────────────────────────────────────────────────────────────
// Operational State 도메인: 주차 결과 상태(weeks 운영 컬럼) — QA 오버레이.
//
// 운영(operating)은 weeks / org_week_thresholds 를 그대로 읽고(기존 코드 경로 유지),
// QA(qa)는 qa_weeks_state / qa_org_week_thresholds 오버레이를 운영 baseline 위에 덧쓴다.
//
//   읽기 해석 = COALESCE(qa 값, 운영 baseline):
//     test 유저 공표상태 = qa_weeks_state.result_published_at ?? weeks.result_published_at.
//     → qa_* 행 삭제(OFF/원복) 시 자동으로 운영 baseline 복귀.
//
//   ⚠ operating 스코프에서는 본 모듈의 read overlay 가 qa_* 를 조회하지 않는다(즉시 반환)
//     → 운영 compute 경로 바이트 동일.
//
// 쓰기 가드/멱등(404/409)·snapshot 재계산은 호출부(lib/adminWeekRecognitionsData)가
// 운영/QA 공통 로직으로 수행하고, 본 모듈은 qa_* 테이블 read/write + 감사 로깅만 담당한다.
// ─────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { StateScope } from "@/lib/operationalState";

export type QaWeekStateRow = {
  week_id: string;
  result_published_at: string | null;
  result_reviewed_at: string | null;
  check_threshold: number | null;
};

// 컬럼 미적용(마이그레이션 2026-07-09_weeks_auto_publish_hold 미실행) 판정 — 42703/does not exist.
function isMissingColumnError(message: string | undefined | null): boolean {
  return /auto_publish_hold_at|column .* does not exist|42703/i.test(message ?? "");
}

// ─── 자동 sweep 재공표 보류(auto_publish_hold) 저수준 write ────────────
//   관리자가 [실행 취소] 하면 now, [검수 완료](재공표) 하면 null 로 세팅한다.
//   스코프 분리: operating=weeks · qa=qa_weeks_state (자동 sweep 은 operating 만 게이트로 읽음).
//   best-effort — 컬럼 미적용(마이그레이션 전)이면 경고만 하고 통과(보류 기능 비활성·기존 흐름 불변).
export async function setWeekAutoPublishHold(
  weekId: string,
  scope: StateScope,
  holdAt: string | null,
  actor: string | null,
): Promise<void> {
  const id = String(weekId ?? "").trim();
  if (!id) return;
  try {
    if (scope === "qa") {
      const { error } = await supabaseAdmin.from("qa_weeks_state").upsert(
        {
          week_id: id,
          auto_publish_hold_at: holdAt,
          updated_at: new Date().toISOString(),
          updated_by: actor,
        },
        { onConflict: "week_id" },
      );
      if (error) throw error;
    } else {
      const { error } = await supabaseAdmin
        .from("weeks")
        .update({ auto_publish_hold_at: holdAt })
        .eq("id", id);
      if (error) throw error;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isMissingColumnError(message)) {
      console.warn(
        "[auto-publish-hold] 컬럼 미적용 — 보류 기록 생략(마이그레이션 2026-07-09_weeks_auto_publish_hold 실행 필요)",
        { weekId: id, scope },
      );
      return;
    }
    console.warn("[auto-publish-hold] set 실패(격리)", { weekId: id, scope, message });
  }
}

export type QaActionName =
  | "publish"
  | "review"
  | "finalize"
  | "check_threshold"
  | "org_check_threshold"
  | "sweep";

// ─── 읽기 오버레이 (compute 경로) ────────────────────────────────────

// growthLoader 가 로드한 weeks 행에 QA 공표상태를 덧쓴다(테스트 유저 대상).
//   operating 스코프 → 즉시 원본 반환(qa_* 무조회, 운영 경로 불변).
//   qa 스코프 → qa_weeks_state.result_published_at 가 NOT NULL 인 주차만 override(COALESCE).
//   조회 실패 → fail-open(운영 baseline 유지) — 실패가 카드를 깨지 않는다.
export async function applyQaWeekPublishOverlay<
  T extends { id: string; result_published_at: string | null },
>(rows: T[], scope: StateScope): Promise<T[]> {
  if (scope !== "qa" || rows.length === 0) return rows;
  const ids = rows.map((r) => r.id);
  const { data, error } = await supabaseAdmin
    .from("qa_weeks_state")
    .select("week_id,result_published_at")
    .in("week_id", ids);
  if (error) {
    console.warn(
      "[operationalState] qa_weeks_state publish overlay failed — fallback to operating baseline",
      { message: error.message },
    );
    return rows;
  }
  const overlay = new Map(
    ((data ?? []) as { week_id: string; result_published_at: string | null }[])
      .filter((r) => r.result_published_at != null)
      .map((r) => [r.week_id, r.result_published_at] as const),
  );
  if (overlay.size === 0) return rows;
  return rows.map((r) =>
    overlay.has(r.id)
      ? { ...r, result_published_at: overlay.get(r.id) ?? r.result_published_at }
      : r,
  );
}

// lineAvailability 의 주차 인정 check 기준값 해석용 QA 오버레이 맵.
//   qa_weeks_state.check_threshold 가 NOT NULL 인 (weekId → 값)만 반환한다.
//   operating 스코프 → 빈 맵(무조회). 조회 실패 → 빈 맵(fail-open: 공통 폴백 유지).
export async function fetchQaWeekCheckThresholdMap(
  weekIds: string[],
  scope: StateScope,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (scope !== "qa" || weekIds.length === 0) return out;
  const { data, error } = await supabaseAdmin
    .from("qa_weeks_state")
    .select("week_id,check_threshold")
    .in("week_id", weekIds);
  if (error) {
    console.warn(
      "[operationalState] qa_weeks_state check_threshold overlay failed — fallback to common threshold",
      { message: error.message },
    );
    return out;
  }
  for (const r of (data ?? []) as {
    week_id: string;
    check_threshold: number | null;
  }[]) {
    if (r.check_threshold != null && r.check_threshold >= 0) {
      out.set(r.week_id, r.check_threshold);
    }
  }
  return out;
}

// ─── 저수준 qa 상태 read/write ───────────────────────────────────────

export async function readQaWeekState(
  weekId: string,
): Promise<QaWeekStateRow | null> {
  const { data, error } = await supabaseAdmin
    .from("qa_weeks_state")
    .select("week_id,result_published_at,result_reviewed_at,check_threshold")
    .eq("week_id", weekId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as QaWeekStateRow | null) ?? null;
}

// qa_weeks_state 부분 upsert(merge). 지정한 컬럼만 갱신(미지정 컬럼은 기존값 보존).
//   onConflict week_id — 행이 없으면 insert, 있으면 지정 컬럼만 update.
export async function writeQaWeekState(
  weekId: string,
  patch: Partial<Pick<
    QaWeekStateRow,
    "result_published_at" | "result_reviewed_at" | "check_threshold"
  >>,
  actor: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("qa_weeks_state")
    .upsert(
      {
        week_id: weekId,
        ...patch,
        updated_at: new Date().toISOString(),
        updated_by: actor,
      },
      { onConflict: "week_id" },
    );
  if (error) throw new Error(error.message);
}

// QA 액션 감사 로그(best-effort — 실패해도 액션을 막지 않는다).
export async function logQaAction(entry: {
  action: QaActionName;
  weekId: string | null;
  before: unknown;
  after: unknown;
  actor: string | null;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("qa_action_log").insert({
      action: entry.action,
      week_id: entry.weekId,
      scope_mode: "qa",
      before_json: entry.before ?? null,
      after_json: entry.after ?? null,
      actor: entry.actor,
    });
    if (error) {
      console.warn("[operationalState] qa_action_log insert failed (action kept)", {
        action: entry.action,
        weekId: entry.weekId,
        message: error.message,
      });
    }
  } catch (e) {
    console.warn("[operationalState] qa_action_log insert threw (action kept)", {
      action: entry.action,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
