/**
 * 기간 등록 검증 잔존 데이터 정리 (이번 검증에서 생성한 행만 — 기존 데이터 무접촉).
 *   - weeks: 2022-spring W1/W2 (검증 스크립트·브라우저 등록분)
 *   - seasons: "2022년도 봄시즌" (find-or-create 신설분)
 *   - official_rest_periods: 2022-03-14~20 temporary (휴식 등록 검증분, 있으면)
 * Usage: npx tsx --env-file=.env.local scripts/cleanup-period-register-test.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// 검증 전 라이브 실측: 아래 season_key 의 weeks 는 0행 — 전부 검증 산출물이다.
const TEST_SEASON_KEYS = ["2022-spring", "2022-winter", "2026-summer"];
const TEST_SEASON_NAMES = ["2022년도 봄시즌", "2022년도 겨울시즌", "2026년도 여름시즌"];

async function main() {
  // 1) weeks: 검증용 season_key 전체
  const { data: weeks, error: wErr } = await sb
    .from("weeks")
    .delete()
    .in("season_key", TEST_SEASON_KEYS)
    .select("id,season_key,week_number,start_date");
  if (wErr) throw new Error(`weeks 삭제 실패: ${wErr.message}`);
  console.log(`weeks 삭제 ${weeks?.length ?? 0}건:`, weeks?.map((w) => `${w.season_key} W${w.week_number}(${w.start_date})`).join(", ") || "-");

  // 2) seasons: find-or-create 신설분
  const { data: seasons, error: sErr } = await sb
    .from("seasons")
    .delete()
    .in("name", TEST_SEASON_NAMES)
    .select("id,name,season_index");
  if (sErr) throw new Error(`seasons 삭제 실패: ${sErr.message}`);
  console.log(`seasons 삭제 ${seasons?.length ?? 0}건:`, seasons?.map((s) => s.name).join(", ") || "-");

  // 3) official_rest_periods: 검증 휴식 등록분 (2022-02~03 범위 temporary 만)
  const { data: periods, error: pErr } = await sb
    .from("official_rest_periods")
    .delete()
    .gte("start_date", "2022-02-01")
    .lte("end_date", "2022-03-31")
    .eq("type", "temporary")
    .select("id,name,start_date,end_date");
  if (pErr && !/official_rest_periods/i.test(pErr.message))
    throw new Error(`periods 삭제 실패: ${pErr.message}`);
  console.log(`official_rest_periods 삭제 ${periods?.length ?? 0}건:`, periods?.map((p) => p.name).join(", ") || "-");

  // 사후: weeks 총행수 확인
  const { count } = await sb.from("weeks").select("id", { count: "exact", head: true });
  console.log(`weeks 총 ${count}행 (기대 153)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
