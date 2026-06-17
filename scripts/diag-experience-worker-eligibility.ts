/**
 * 진단 전용(read-only): experience/encre 체크 행이 "체크 대기"에서 멈춘 원인 분리.
 *   - process_check_statuses 전 컬럼 덤프(week_id/act_id/scope_mode/attempt/last_error/...)
 *   - 보드 주차(test=W13 / operating=W16) 매칭 여부
 *   - worker findDueItems + eligible 로직 재현(현재 시각 기준, modes=all vs modes=['test'])
 *
 *   실행:  npx tsx --env-file=.env.local scripts/diag-experience-worker-eligibility.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProcessWeek } from "@/lib/adminProcessCheckData";

const ORG = "encre";
const HUB = "experience";
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);
const COOLDOWN_MS = Number(process.env.WORKER_COOLDOWN_MS ?? 600_000);
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(76));

async function main() {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  line(`현재 시각(now) = ${nowIso}`);

  hr();
  line("[0] 보드 기준 주차 (resolveProcessWeek)");
  hr();
  const wTest = await resolveProcessWeek("test", "process-experience");
  const wOp = await resolveProcessWeek("operating", "process-experience");
  line(`  test      → weekId=${wTest?.weekId} · ${wTest?.periodLabel}`);
  line(`  operating → weekId=${wOp?.weekId} · ${wOp?.periodLabel}`);

  hr();
  line(`[1] process_check_statuses 전체 행 — org=${ORG} hub=${HUB}`);
  hr();
  const { data, error } = await supabaseAdmin
    .from("process_check_statuses")
    .select(
      "id,week_id,team_id,act_id,line_group_id,status,scope_mode,review_link,scheduled_check_at,requested_at,completed_at,checked_crew_count,attempt_count,last_attempt_at,last_error,part_name",
    )
    .eq("organization_slug", ORG)
    .eq("hub", HUB);
  if (error) {
    line(`  조회 오류: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as any[];
  line(`  총 ${rows.length} 행`);
  for (const r of rows) {
    const board =
      r.week_id === wTest?.weekId
        ? "TEST보드(W13)"
        : r.week_id === wOp?.weekId
          ? "OPERATING보드(W16)"
          : "기타주차(보드 미표시)";
    line("");
    line(`  • row=${r.id}`);
    line(`    board=${board}  week_id=${r.week_id}`);
    line(`    act_id=${r.act_id}  team_id=${r.team_id ?? "-"}  part_name=${r.part_name ?? "-"}`);
    line(`    status=${r.status}  scope_mode=${r.scope_mode ?? "(null→operating)"}`);
    line(`    scheduled_check_at=${r.scheduled_check_at ?? "-"}  (과거=${r.scheduled_check_at ? Date.parse(r.scheduled_check_at) <= now : "n/a"})`);
    line(`    requested_at=${r.requested_at ?? "-"}  completed_at=${r.completed_at ?? "-"}`);
    line(`    review_link=${r.review_link ? "있음" : "없음"}`);
    line(`    attempt_count=${r.attempt_count ?? 0}  last_attempt_at=${r.last_attempt_at ?? "null"}  last_error=${r.last_error ?? "null"}`);
    line(`    checked_crew_count=${r.checked_crew_count ?? "null"}`);

    // 판단 기준(사용자 정의)
    const ac = r.attempt_count ?? 0;
    let verdict: string;
    if (ac === 0 && !r.last_attempt_at && !r.last_error) {
      verdict = "(1) worker가 이 행을 아예 안 잡음 (미실행/스코프 제외/스케줄 미도래)";
    } else if (ac > 0 && r.last_error) {
      verdict = `(2) worker 실행됐으나 실패: ${r.last_error}`;
    } else if (ac > 0 && !r.last_error && (r.checked_crew_count ?? 0) === 0 && r.status === "pending") {
      verdict = "(3) 정상완료(0명)여야 하는데 status=pending → 상태 전환 버그";
    } else {
      verdict = `상태=${r.status} attempt=${ac} → 위 분류 외`;
    }
    line(`    ▶ 판단 = ${verdict}`);
  }

  hr();
  line("[2] worker findDueItems 재현 — status='pending' AND scheduled<=now AND review_link NOT NULL");
  hr();
  const { data: due } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,organization_slug,scope_mode,review_link,attempt_count,last_attempt_at,scheduled_check_at,status")
    .eq("status", "pending")
    .lte("scheduled_check_at", nowIso)
    .not("review_link", "is", null);
  const dueRows = ((due ?? []) as any[]).filter(
    (d) => d.organization_slug === ORG, // 진단은 encre 만(worker 는 전 org)
  );
  line(`  due(encre, 전 hub·pending·과거·링크) = ${dueRows.length} 행`);
  for (const d of dueRows) {
    // eligible 필터 재현(modes 가정별).
    const cooled = !d.last_attempt_at || now - Date.parse(d.last_attempt_at) >= COOLDOWN_MS;
    const underMax = (d.attempt_count ?? 0) < MAX_ATTEMPTS;
    const sm = d.scope_mode ?? "operating";
    const eligAll = underMax && cooled; // modes=null(전체)
    const eligTestOnly = eligAll && sm === "test"; // WORKER_MODES=test
    const eligOpOnly = eligAll && sm === "operating"; // WORKER_MODES=operating
    line(`  • row=${d.id} scope_mode=${sm} attempt=${d.attempt_count ?? 0}`);
    line(`    eligible[modes=all]=${eligAll}  eligible[WORKER_MODES=test]=${eligTestOnly}  eligible[WORKER_MODES=operating]=${eligOpOnly}`);
  }

  hr();
  line("[3] 핵심 점검 — 보드 write 가 scope_mode 를 기록하는가?");
  hr();
  const smDist: Record<string, number> = {};
  for (const r of rows) smDist[r.scope_mode ?? "(null)"] = (smDist[r.scope_mode ?? "(null)"] ?? 0) + 1;
  line(`  scope_mode 분포(encre/experience): ${JSON.stringify(smDist)}`);
  const testBoardRows = rows.filter((r) => r.week_id === wTest?.weekId);
  line(`  TEST보드(W13) 주차 행 = ${testBoardRows.length}개, 그 중 scope_mode='test' = ${testBoardRows.filter((r) => r.scope_mode === "test").length}개`);
  line("  ※ 보드(test)에서 만든 체크 신청이 scope_mode='operating'(기본값)으로 저장되면,");
  line("    WORKER_MODES=test 인 worker 는 이 행을 영원히 못 잡는다(스코프 불일치) → 체크 대기 고착.");

  hr();
  line("DONE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
