/**
 * 진단 전용(read-only): /admin/processes/check/experience 의 "검수 크루 - (0명)" 원인 분리.
 *
 *   질문: 0명이 (a) 크롤링/매칭을 수행한 결과 0명인지, (b) 검수 로직 미실행/기본값 "-"인지.
 *
 *   확인:
 *     1) experience/encre 체크 상태 행(process_check_statuses) — status/scheduled/attempt/last_error/checked_crew_count
 *     2) 식별 결과(process_check_review_recipients) — matched vs review(수동확인) 분리
 *     3) reviewerResolutionStatus 파생: not_started | no_comments | comments_found_no_match | matched | error
 *     4) mode=test vs operating 크루 모집단 크기(매칭 입력 풀) 비교
 *
 *   실행:  npx tsx --env-file=.env.local scripts/diag-experience-reviewer-crew.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProcessWeek } from "@/lib/adminProcessCheckData";
import { resolveUserScope } from "@/lib/userScope";
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";

const ORG = "encre";
const HUB = "experience";
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));

// 식별 결과(recipients)로부터 검수자 해소 상태 파생.
//   status!=completed → not_started(검수 로직 미실행) / last_error 있으면 error
//   completed + matched>0 → matched
//   completed + review>0 + matched=0 → comments_found_no_match(댓글은 있으나 스코프 내 매칭 0)
//   completed + 결과 0행 → no_comments(댓글 자체 없음)
function deriveStatus(
  status: string,
  lastError: string | null,
  matched: number,
  review: number,
): string {
  if (lastError) return "error";
  if (status !== "completed") return "not_started";
  if (matched > 0) return "matched";
  if (review > 0) return "comments_found_no_match";
  return "no_comments";
}

async function weekContext() {
  hr();
  line("[0] 보드 기준 주차 (resolveProcessWeek)");
  hr();
  for (const mode of ["operating", "test"] as const) {
    const w = await resolveProcessWeek(mode, "process-experience");
    line(
      `  mode=${mode}: weekId=${w?.weekId ?? "(null)"} · ${w?.periodLabel ?? "-"} · editable=${w?.editable}`,
    );
  }
}

async function statusRows() {
  hr();
  line(`[1] process_check_statuses — org=${ORG} hub=${HUB} (전체 주차)`);
  hr();
  const { data, error } = await supabaseAdmin
    .from("process_check_statuses")
    .select(
      "id,week_id,team_id,act_id,status,scope_mode,review_link,scheduled_check_at,requested_at,completed_at,checked_crew_count,attempt_count,last_attempt_at,last_error,part_name",
    )
    .eq("organization_slug", ORG)
    .eq("hub", HUB)
    .order("scheduled_check_at", { ascending: true, nullsFirst: true });
  if (error) {
    line(`  (조회 오류: ${error.message})`);
    return [] as any[];
  }
  const rows = (data ?? []) as any[];
  line(`  총 ${rows.length} 행`);
  if (rows.length === 0) {
    line("  → experience/encre 에 체크 신청/상태 행이 하나도 없음.");
    line("    = 아무도 [체크 신청]을 안 했음 → 모든 액트 status=needed(기본값) → '검수 크루 -'.");
    line("    이 경우 0명은 '크롤링 결과 0'이 아니라 '검수 로직 미실행(신청 자체 없음)'.");
  }
  // mode/상태 분포
  const dist: Record<string, number> = {};
  for (const r of rows) {
    const k = `${r.scope_mode ?? "operating"}/${r.status}`;
    dist[k] = (dist[k] ?? 0) + 1;
  }
  line(`  분포(scope_mode/status): ${JSON.stringify(dist)}`);
  return rows;
}

async function recipientsFor(rows: any[]) {
  hr();
  line("[2]+[3] 식별 결과(recipients) + reviewerResolutionStatus 파생");
  hr();
  if (rows.length === 0) {
    line("  (상태 행 없음 → recipients 없음)");
    return;
  }
  const ids = rows.map((r) => r.id);
  const { data, error } = await supabaseAdmin
    .from("process_check_review_recipients")
    .select("ref_id,match_type,nickname,user_id,match_reason")
    .eq("source", "regular")
    .in("ref_id", ids);
  if (error) {
    line(`  (recipients 조회 오류: ${error.message})`);
    line("  → 테이블 미적용일 수 있음(2026-06-15_process_check_worker.sql).");
  }
  const byRef = new Map<string, { matched: any[]; review: any[] }>();
  for (const r of (data ?? []) as any[]) {
    let e = byRef.get(r.ref_id);
    if (!e) byRef.set(r.ref_id, (e = { matched: [], review: [] }));
    (r.match_type === "matched" ? e.matched : e.review).push(r);
  }
  for (const r of rows) {
    const e = byRef.get(r.id) ?? { matched: [], review: [] };
    const resolution = deriveStatus(r.status, r.last_error, e.matched.length, e.review.length);
    line("");
    line(`  • status_row=${r.id.slice(0, 8)} mode=${r.scope_mode ?? "operating"} act=${r.act_id.slice(0, 8)} part=${r.part_name ?? "-"}`);
    line(
      `    status=${r.status} scheduled=${r.scheduled_check_at ?? "-"} completed=${r.completed_at ?? "-"}`,
    );
    line(
      `    reviewLink=${r.review_link ? "있음" : "없음"} attempt=${r.attempt_count ?? 0} lastError=${r.last_error ?? "-"}`,
    );
    line(`    checked_crew_count(DB)=${r.checked_crew_count ?? "null"}`);
    line(
      `    recipients: crawledCommentCount(추정=matched+review)=${e.matched.length + e.review.length} · matchedCrewCount=${e.matched.length} · unmatched(review)=${e.review.length}`,
    );
    if (e.review.length) {
      line(`    unmatchedCommentAuthors=${JSON.stringify(e.review.map((x) => x.nickname).slice(0, 20))}`);
    }
    line(`    ▶ reviewerResolutionStatus = ${resolution}`);
  }
}

async function crewPoolSizes() {
  hr();
  line("[4] 매칭 입력 크루 모집단 크기 (org=encre) — test vs operating");
  hr();
  const crews = await loadCrewRecords(ORG);
  line(`  loadCrewRecords(encre) 전체(org) = ${crews.length}명`);
  for (const mode of ["operating", "test"] as const) {
    const scope = await resolveUserScope(mode, ORG as any);
    const scoped = scope.filter(crews, (c) => c.userId);
    line(`  mode=${mode}: 매칭 풀 = ${scoped.length}명 (test_user_markers ${scope.testUserIds.size}건 적용)`);
  }
  line("");
  line("  ※ mode=test 풀에 실사용자가 없으면, 실사용자가 카페에 댓글을 달아도");
  line("    매칭 0명이 정상(comments_found_no_match) — 기능 실패 아님.");
}

async function main() {
  await weekContext().catch((e) => line(`[0] 실패: ${e.message}`));
  const rows = await statusRows().catch((e) => {
    line(`[1] 실패: ${e.message}`);
    return [] as any[];
  });
  await recipientsFor(rows).catch((e) => line(`[2] 실패: ${e.message}`));
  await crewPoolSizes().catch((e) => line(`[4] 실패: ${e.message}`));
  hr();
  line("DONE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
