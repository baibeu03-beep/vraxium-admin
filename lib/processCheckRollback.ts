// Process Check ↩ 실행 취소('실행 전' 완전 복원) — 운영/테스트 공용(QA 전용 아님).
//
//   완료된 정규 체크(process_check_statuses.status='completed')를 '체크 필요'(needed)로 되돌린다:
//     1) 포인트 회수 revokeForAct("regular", statusId) — process_point_awards 삭제 +
//        user_weekly_points 재합산(→0) + 대상 유저 snapshot 무효화.
//     2) recipients 삭제(sweep 이 완료 시 기록한 process_check_review_recipients).
//     3) status completed → needed. review_link·scheduled_check_at·requested_at 등 'pending'
//        정의값을 **모두 비운다**(= 체크 신청 취소와 동일 초기화). 이유: pending 으로 되돌리면
//        '체크 대기' 로 떠서 최초 입력한 검수링크·검수시점을 고칠 방법이 없다. needed 로 내려야
//        관리자가 검수링크·검수시점을 다시 입력(재-신청)할 수 있다.
//     4) 대상 유저 snapshot **명시적 재계산**(invalidate 의 컨텍스트 의존 우회 → direct==HTTP 결정성).
//
//   안전성(운영에서도 ↩ 제공하는 근거): 전 단계가 멱등·가역이다.
//     - revokeForAct: 원장 유니크(source,ref_id,user_id)·uwp=SUM 재합산 → 두 번 호출해도 동일.
//     - recipients: delete-then(재신청·재완료 시) re-insert. status: needed→pending→completed 재진입 가능.
//     - 재-신청 후 재완료(자동 sweep 또는 즉시 검수)로 원상 복구 가능 → 비가역 부작용 없음.
//   운영 자동 완료 행도 되돌릴 수 있으나, 실크루 포인트/카드에 영향을 주므로 호출부(UI)는 반드시
//   강한 확인 절차(ActionControl 확인 모달)를 거친다. 자동 스케줄(sweep) 자체는 무변경.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { revokeForAct } from "@/lib/processPointAccrual";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  commentCollectionColumnsAvailable,
  logProcessCheckRolledBackForRegular,
} from "@/lib/adminProcessCheckData";
import { uncompleteResetStamp } from "@/lib/processCheckCollectionReset";

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

  // 3) status completed → needed('실행 전' 완전 복원). 검수링크·검수시점 등 pending 정의값을
  //   모두 비워 '체크 필요' 로 내린다(= 체크 신청 취소와 동일 stamp) → 관리자가 재입력 가능.
  //   멱등 가드(.eq status completed).
  //   ⚠ 이전 검수 시도의 수집 진단값(last_error·수집 상태·원본 댓글 수·오류 코드)도 함께 초기화한다 —
  //     recipients·checked_crew_count 를 이미 지우므로, 남은 수집값이 재검수 최신 결과처럼 노출되면 안 된다.
  const collectionAvail = await commentCollectionColumnsAvailable();
  await supabaseAdmin
    .from("process_check_statuses")
    .update({
      status: "needed",
      review_link: null,
      scheduled_check_at: null,
      requested_at: null,
      requested_by: null,
      completed_at: null,
      checked_crew_count: null,
      ...uncompleteResetStamp(collectionAvail),
    })
    .eq("id", statusId)
    .eq("status", "completed");

  // 4) 대상 유저 snapshot 명시적 재계산(direct==HTTP 결정성).
  let recompute: { requested: number; recomputed: number; failed: number } | undefined;
  if (revokedUserIds.length > 0) {
    const rc = await recomputeWeeklyCardsSnapshotsForUsers(revokedUserIds, { concurrency: 4 });
    recompute = { requested: rc.requested, recomputed: rc.recomputed, failed: rc.failed };
  }

  // 5) 실행 취소 로그 — 상태창(로그)에 "실행 취소 · 관리자 이름" 을 시간순 기록. 실제 completed→pending
  //   전이가 일어난 이 경로에서만(위 early-return 은 no-op → 미기록). best-effort(로그 실패가 취소를 안 깸).
  await logProcessCheckRolledBackForRegular(statusId, { adminId: opts.actor ?? null });

  return { ok: true, status: "needed", statusId, scopeMode, revokedUserIds, recipientsDeleted, recompute };
}
