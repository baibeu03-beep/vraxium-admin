/**
 * 일회성 데이터 보정(targeted): 테스트 보드(W13)에서 만들어졌으나 scope_mode 가 기본값
 *   'operating' 으로 저장된 encre/experience 체크 신청 행을 'test' 로 정정한다.
 *   (코드 버그 수정 전 생성된 행만 대상 — 신규 신청은 적용 후 올바르게 저장됨.)
 *
 *   안전: status/scheduled/recipients 무변경. scope_mode 컬럼만 update. 멱등(이미 test 면 skip).
 *   실행:  npx tsx --env-file=.env.local scripts/fix-experience-test-row-scope-mode.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProcessWeek } from "@/lib/adminProcessCheckData";

const ORG = "encre";
const HUB = "experience";

async function main() {
  const wTest = await resolveProcessWeek("test", "process-experience");
  if (!wTest?.weekId) throw new Error("test week 해소 실패");
  console.log(`test 보드 주차 weekId=${wTest.weekId} (${wTest.periodLabel})`);

  // 테스트 보드 주차 + 기본값 operating 으로 잘못 저장된 행만 대상.
  const { data: targets, error } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,scope_mode,status,week_id")
    .eq("organization_slug", ORG)
    .eq("hub", HUB)
    .eq("week_id", wTest.weekId)
    .eq("scope_mode", "operating");
  if (error) throw new Error(error.message);
  const rows = (targets ?? []) as Array<{ id: string; status: string }>;
  console.log(`대상(테스트 주차 + scope_mode='operating') = ${rows.length}행`);
  if (rows.length === 0) {
    console.log("정정할 행 없음(이미 test 이거나 행 없음) — 멱등 종료.");
    return;
  }
  for (const r of rows) console.log(`  - ${r.id} status=${r.status}`);

  const ids = rows.map((r) => r.id);
  const { error: uErr, count } = await supabaseAdmin
    .from("process_check_statuses")
    .update({ scope_mode: "test" }, { count: "exact" })
    .in("id", ids);
  if (uErr) throw new Error(uErr.message);
  console.log(`✓ scope_mode='test' 정정 완료 — ${count ?? ids.length}행 (status/scheduled/recipients 무변경)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
