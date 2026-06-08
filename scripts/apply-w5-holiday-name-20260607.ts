// 2025-winter W5(25-WI-05) weeks.holiday_name="설 연휴" 단건 설정 (2026-06-07).
// official_rest_periods "2025 설 연휴"와 비고 표시 정합 목적. 다른 row 일절 미수정.
import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WEEK_ID = "b39ebb3d-7d9f-444d-84b1-8e2ed858b2d5"; // 2025-winter W5 2025-01-27~02-02

async function main() {
  const { data: before, error: bErr } = await supabaseAdmin
    .from("weeks").select("*").eq("id", WEEK_ID).single();
  if (bErr) throw bErr;
  // 가드: 대상 행 정합 확인
  if (
    before.season_key !== "2025-winter" ||
    before.week_number !== 5 ||
    before.start_date !== "2025-01-27" ||
    before.holiday_name !== null
  ) {
    throw new Error(`guard failed: ${JSON.stringify(before)}`);
  }
  writeFileSync(
    "claudedocs/w5-holiday-name-backup-20260607.json",
    JSON.stringify({ backedUpAt: new Date().toISOString(), before }, null, 2),
    "utf-8",
  );
  console.log("백업 저장: claudedocs/w5-holiday-name-backup-20260607.json");

  const { data: after, error: uErr } = await supabaseAdmin
    .from("weeks")
    .update({ holiday_name: "설 연휴" })
    .eq("id", WEEK_ID)
    .select("id,season_key,week_number,start_date,end_date,holiday_name,is_official_rest");
  if (uErr) throw uErr;
  if ((after ?? []).length !== 1) throw new Error(`expected 1 row updated, got ${after?.length}`);
  console.log("적용:", JSON.stringify(after![0]));

  const { count: stale } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true })
    .eq("is_stale", true);
  console.log(`[snapshot] is_stale=true: ${stale ?? 0}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
