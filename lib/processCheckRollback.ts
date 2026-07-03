// Process Check ↩ 실행 취소(직전 단계 복원) — 운영/테스트 공용(QA 전용 아님).
//
//   완료된 정규 체크(process_check_statuses.status='completed')를 직전 단계(pending)로 되돌린다:
//     1) 포인트 회수 revokeForAct("regular", statusId) — process_point_awards 삭제 +
//        user_weekly_points 재합산(→0) + 대상 유저 snapshot 무효화.
//     2) recipients 삭제(sweep 이 완료 시 기록한 process_check_review_recipients).
//     3) status completed → pending(completed_at·checked_crew_count null). review_link·
//        scheduled_check_at 등 'pending' 정의값은 보존 → 재-검수 라운드트립 가능.
//     4) 대상 유저 snapshot **명시적 재계산**(invalidate 의 컨텍스트 의존 우회 → direct==HTTP 결정성).
//
//   안전성(운영에서도 ↩ 제공하는 근거): 전 단계가 멱등·가역이다.
//     - revokeForAct: 원장 유니크(source,ref_id,user_id)·uwp=SUM 재합산 → 두 번 호출해도 동일.
//     - recipients: delete-then(재완료 시) re-insert. status: pending↔completed 왕복 가능.
//     - 재완료(자동 sweep 또는 즉시 검수)로 원상 복구 가능 → 비가역 부작용 없음.
//   운영 자동 완료 행도 되돌릴 수 있으나, 실크루 포인트/카드에 영향을 주므로 호출부(UI)는 반드시
//   강한 확인 절차(ActionControl 확인 모달)를 거친다. 자동 스케줄(sweep) 자체는 무변경.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { revokeForAct } from "@/lib/processPointAccrual";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

export type ProcessCheckRollbackResult = {
  ok: boolean;
  statusId: string;
  status: "pending" | "completed" | "needed" | "not_found";
  scopeMode: "operating" | "test" | null;
  revokedUserIds: string[];
  recipientsDeleted: number;
  recompute?: { requested: number; recomputed: number; failed: number };
};

export async function rollbackProcessCheckCompletion(opts: {
  statusId: string;
  actor?: string | null;
}): Promise<ProcessCheckRollbackResult> {
  const statusId = String(opts.statusId ?? "").trim();
  const base = { statusId, revokedUserIds: [] as string[], recipientsDeleted: 0, scopeMode: null as ProcessCheckRollbackResult["scopeMode"] };
  if (!statusId) return { ok: false, status: "not_found", ...base };

  const { data: row } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,status,scope_mode")
    .eq("id", statusId)
    .maybeSingle();
  if (!row) return { ok: false, status: "not_found", ...base };

  const r = row as { status: string; scope_mode: string | null };
  const scopeMode: "operating" | "test" = r.scope_mode === "test" ? "test" : "operating";
  // 완료가 아니면 되돌릴 게 없음 → 멱등 성공(현재 상태 보고).
  if (r.status !== "completed") {
    return { ok: true, status: r.status as ProcessCheckRollbackResult["status"], ...base, scopeMode };
  }

  // 1) 포인트 회수(원장 삭제 + user_weekly_points 재합산 + snapshot 무효화).
  const { revokedUserIds } = await revokeForAct("regular", statusId);

  // 2) recipients 삭제.
  const { data: delRec } = await supabaseAdmin
    .from("process_check_review_recipients")
    .delete()
    .eq("source", "regular")
    .eq("ref_id", statusId)
    .select("id");
  const recipientsDeleted = (delRec ?? []).length;

  // 3) status completed → pending(직전 단계 복원). 멱등 가드(.eq status completed).
  await supabaseAdmin
    .from("process_check_statuses")
    .update({ status: "pending", completed_at: null, checked_crew_count: null })
    .eq("id", statusId)
    .eq("status", "completed");

  // 4) 대상 유저 snapshot 명시적 재계산(direct==HTTP 결정성).
  let recompute: { requested: number; recomputed: number; failed: number } | undefined;
  if (revokedUserIds.length > 0) {
    const rc = await recomputeWeeklyCardsSnapshotsForUsers(revokedUserIds, { concurrency: 4 });
    recompute = { requested: rc.requested, recomputed: rc.recomputed, failed: rc.failed };
  }

  return { ok: true, status: "pending", statusId, scopeMode, revokedUserIds, recipientsDeleted, recompute };
}
