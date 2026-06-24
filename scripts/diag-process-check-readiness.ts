// READ-ONLY 진단: 프로세스 체크(자동 검수) 생성 경로 적용 가능성 점검. write 0.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function tableState(name: string, filter?: (q: any) => any) {
  let q = sb.from(name).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  return error ? `ERR(${error.code ?? ""}: ${error.message})` : `${count} rows`;
}

(async () => {
  console.log("=== 프로세스 체크 테이블/데이터 상태 (READ-ONLY) ===\n");
  for (const t of ["process_line_groups", "process_acts", "process_check_statuses", "process_check_review_recipients", "process_check_logs", "process_point_awards"]) {
    console.log(`  ${t.padEnd(34)}: ${await tableState(t)}`);
  }
  console.log("\n--- hub=info process_line_groups / process_acts ---");
  console.log(`  process_line_groups hub=info : ${await tableState("process_line_groups", (q) => q.eq("hub", "info"))}`);
  console.log(`  process_acts hub=info        : ${await tableState("process_acts", (q) => q.eq("hub", "info"))}`);
  console.log(`  process_acts hub=info active : ${await tableState("process_acts", (q) => q.eq("hub", "info").eq("is_active", true))}`);

  const { data: acts } = await sb.from("process_acts").select("id,hub,act_name,act_type,check_target,is_active").eq("hub", "info");
  if (acts && acts.length) {
    console.log("\n  info 액트 목록:");
    for (const a of acts as any[]) console.log(`    · ${a.id.slice(0,8)} "${a.act_name}" type=${a.act_type} check_target=${a.check_target} active=${a.is_active}`);
  } else {
    console.log("\n  ⚠ hub=info 액트 0건 → '검수 신청(request)' 대상 액트가 존재하지 않음(생성 불가).");
  }

  // 현재 주차 vs dry-run 대상 주차(전부 과거)
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n--- 주차 경계 (오늘 ${today}) ---`);
  const { data: cur } = await sb.from("weeks").select("id,season_key,week_number,start_date").lte("start_date", today).order("start_date", { ascending: false }).limit(1);
  console.log(`  현재(최근 시작) 주차: ${(cur?.[0] as any)?.season_key} ${(cur?.[0] as any)?.week_number}주차 start=${(cur?.[0] as any)?.start_date}`);
  console.log(`  dry-run 309 라인 최신 주차 = 2026-spring W4 (start 2026-03-23) → 전부 과거. request 경로는 현재 주차만 생성(과거 불가).`);
})();
