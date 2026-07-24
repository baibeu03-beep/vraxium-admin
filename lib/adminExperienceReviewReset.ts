// 실무 경험 [개설 검수] 취소 — 데이터 레이어(standalone).
//
// 파트 신청 데이터가 실제로 바뀌면 그 팀·주차의 개설 검수(status='reviewed')를 취소한다.
//   status='none' 으로 되돌리고 reviewed_by/at 을 비운다. 팀장 입력(관리/확장 셀)과 아웃풋은
//   보존한다 — 헤더를 지우면 CASCADE 로 함께 사라지므로 재검수 비용이 커진다.
//
// ⚠ 이 모듈은 supabaseAdmin + 개설 로그만 의존한다(adminExperienceTeamOverall ↔ adminExperiencePartInput
//   순환 import 회피). 판정 규칙 자체는 lib/experienceReviewResetPolicy.ts(browser-safe)가 SoT.
//
// ⚠ snapshot 생성/조회·고객 라인(cluster4_lines)·demoUserId·일반 사용자 경로 무접촉.
//   status='opened'(개설 완료)는 대상이 아니다 — 고객 반영을 되돌리는 [개설 취소]가 별도로 존재한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { insertExperienceOpeningLog } from "@/lib/adminExperienceOpeningLogs";
import {
  REVIEW_RESET_FAILED_MESSAGE,
  resolveOverallStatus,
} from "@/lib/experienceReviewResetPolicy";

export type OverallReviewStatus = "none" | "reviewed" | "opened";

export type OverallReviewState = {
  id: string | null;
  status: OverallReviewStatus;
};

/** (org, week, team) 팀 총괄 헤더의 현재 검수 상태. 헤더가 없거나 검수 취소됐으면 'none'(검수 전). */
export async function loadOverallReviewState(
  organization: string,
  weekId: string,
  teamId: string,
): Promise<OverallReviewState> {
  const { data, error } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .select("id,status,reviewed_at")
    .eq("organization_slug", organization)
    .eq("week_id", weekId)
    .eq("team_id", teamId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as
    | { id: string; status: string | null; reviewed_at: string | null }
    | null;
  if (!row) return { id: null, status: "none" };
  // 판독은 반드시 공용 resolver 경유 — status='none'(마이그 적용 후)과 reviewed_at=NULL sentinel 을 함께 읽는다.
  return {
    id: row.id,
    status: resolveOverallStatus({ status: row.status, reviewedAt: row.reviewed_at }),
  };
}

/**
 * 개설 검수 취소 — status reviewed → none.
 *
 *   · `.eq("status","reviewed")` 조건부 UPDATE — 그 사이 [개설 완료](opened)로 승격됐으면 건드리지 않는다.
 *   · 호출 순서 규약: **파트 신청 저장이 성공한 뒤에만** 호출한다(저장 실패 시 검수가 취소되면 안 됨).
 *   · 로그(action='review_cancel')는 best-effort — 실패해도 검수 취소 자체는 유효하다.
 *
 * @returns 실제로 취소했으면 true(이미 none/opened 였으면 false).
 */
export async function cancelOverallReviewForDataChange(input: {
  organization: string;
  weekId: string;
  teamId: string;
  teamName?: string | null;
  /** 로그 실행자(임퍼소네이션 유효 시 그 테스트 유저=파트장, 아니면 실 admin). */
  actorUserId: string | null;
  /** 로그 파트명. 파트 단위 변경이면 그 파트명, 팀 단위면 비운다. */
  partName?: string | null;
}): Promise<boolean> {
  const state = await loadOverallReviewState(
    input.organization,
    input.weekId,
    input.teamId,
  );
  if (!state.id || state.status !== "reviewed") return false;

  // ① 정상 표현: status='none'.
  //    2026-07-23 마이그레이션(status CHECK 에 'none' 추가) 미적용 환경에서는 CHECK 위반으로 거부된다.
  // ② 그 경우에만 sentinel(reviewed_at=NULL, status 유지)로 되돌린다 — 판독은 resolveOverallStatus 가
  //    두 표현을 동일하게 'none' 으로 읽으므로 화면/게이트 동작은 완전히 같다.
  let { data, error } = await supabaseAdmin
    .from("cluster4_experience_team_overall")
    .update({ status: "none", reviewed_by: null, reviewed_at: null })
    .eq("id", state.id)
    .eq("status", "reviewed")
    .select("id");
  if (error) {
    console.warn(
      "[experience review-reset] status='none' 거부 — reviewed_at sentinel 로 대체:",
      error.message,
    );
    ({ data, error } = await supabaseAdmin
      .from("cluster4_experience_team_overall")
      .update({ reviewed_by: null, reviewed_at: null })
      .eq("id", state.id)
      .eq("status", "reviewed")
      .select("id"));
  }
  if (error) {
    // 저장은 이미 끝났으므로 여기서 조용히 넘기면 "검수 완료" 표시가 남는다 — 명시적으로 알린다.
    throw Object.assign(new Error(REVIEW_RESET_FAILED_MESSAGE), {
      status: 500,
      cause: error,
    });
  }
  const updated = ((data ?? []) as Array<{ id: string }>).length > 0;
  if (!updated) return false; // 동시성: 그 사이 opened 승격 등 — 검수 취소 대상 아님.

  await insertExperienceOpeningLog({
    action: "review_cancel",
    weekId: input.weekId,
    organizationSlug: input.organization,
    actorUserId: input.actorUserId,
    teamId: input.teamId,
    teamName: input.teamName ?? null,
    partName: input.partName ?? null,
    isTeamLevel: !input.partName,
  });
  return true;
}
