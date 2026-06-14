// 기간 등록(/admin/periods/register) 저장 구조 — 읽기 전용 실 DB 검증.
//   POST 는 고객앱이 직접 소비하는 weeks SoT 에 write 하므로 여기서는 write 하지 않는다.
//   - GET 라우트(season-weeks)가 읽는 테이블이 실제로 존재/접근 가능한지
//   - SoT(weeks) 및 보조(seasons/season_definitions/official_rest_periods) shape 확인
//
// 실행: npx tsx --env-file=.env.local scripts/verify-periods-register-readonly.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function countAndSample(table: string, cols: string) {
  const { count, error: cErr } = await supabaseAdmin
    .from(table)
    .select("*", { count: "exact", head: true });
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(cols)
    .limit(2);
  return {
    table,
    ok: !error && !cErr,
    count: count ?? null,
    error: (error ?? cErr)?.message ?? null,
    sample: data ?? [],
  };
}

async function main() {
  console.log("=== 기간 등록 SoT 테이블 읽기 전용 검증 ===\n");

  const targets = [
    ["weeks", "id,season_key,week_number,week_index,start_date,end_date,is_official_rest,iso_year,iso_week,holiday_name,season_id"],
    ["seasons", "id,season_index,name,started_at,ended_at"],
    ["season_definitions", "season_key,season_label,season_type,start_date,end_date"],
    ["official_rest_periods", "id,name,type,start_date,end_date,is_active"],
  ] as const;

  for (const [table, cols] of targets) {
    const r = await countAndSample(table, cols);
    console.log(`[${table}] ok=${r.ok} count=${r.count}${r.error ? ` ERROR=${r.error}` : ""}`);
    if (r.sample.length) console.log("  sample:", JSON.stringify(r.sample[0]));
    console.log();
  }

  // GET 라우트가 의존하는 핵심 조인 확인: weeks.season_key 가 season_definitions 에 존재하는가.
  const { data: orphanWeeks } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number")
    .limit(5);
  console.log("=== weeks 최근 샘플(등록 결과가 즉시 들어가는 곳) ===");
  console.log(JSON.stringify(orphanWeeks ?? [], null, 2));

  // 고객앱 소비 컬럼 존재 확인(cluster4WeeklyGrowthData 가 select 하는 컬럼).
  const { data: customerCols, error: ccErr } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name,iso_year,iso_week,result_published_at")
    .limit(1);
  console.log(
    `\n[고객앱 소비 컬럼셋 select] ok=${!ccErr}${ccErr ? ` ERROR=${ccErr.message}` : ""} rows=${(customerCols ?? []).length}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
