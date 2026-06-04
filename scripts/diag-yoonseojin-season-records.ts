/**
 * READ-ONLY 진단: T윤서진 이력서 카드 seasonRecords vs cluster4 weekly cards 시즌 판정 대조.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data: profiles } = await sb
    .from("user_profiles")
    .select("user_id, display_name")
    .ilike("display_name", "%윤서진%");
  console.log("profiles:", profiles);
  if (!profiles?.length) return;
  const userId = profiles[0].user_id;

  const { data: seasons } = await sb
    .from("season_definitions")
    .select("season_key,season_label,season_type,start_date,end_date")
    .order("start_date", { ascending: false });
  console.log("\nseason_definitions:");
  for (const s of seasons ?? []) console.log(` ${s.season_key} | ${s.season_type} | ${s.start_date} ~ ${s.end_date} | ${s.season_label}`);

  const { data: ws } = await sb
    .from("user_week_statuses")
    .select("week_start_date, status, season_key, week_number, year")
    .eq("user_id", userId)
    .order("week_start_date", { ascending: true });

  console.log("\nuser_week_statuses:");
  for (const r of (ws ?? []) as any[]) {
    console.log(` ${r.week_start_date} | wk${String(r.week_number).padStart(2)} | ${String(r.status).padEnd(13)} | season=${r.season_key} | year=${r.year}`);
  }

  // group by season like computeSeasonRecords
  const bySeason = new Map<string, any[]>();
  for (const w of (ws ?? []) as any[]) {
    if (!w.season_key) continue;
    const arr = bySeason.get(w.season_key) ?? [];
    arr.push(w);
    bySeason.set(w.season_key, arr);
  }
  console.log("\n=== computeSeasonRecords 현재 로직 재현 ===");
  for (const [key, rows] of bySeason) {
    const totalWeeks = rows.length;
    const approved = rows.filter((w) => w.status === "success").length;
    const hasRest = rows.some((w) => w.status === "personal_rest");
    const hasFail = rows.some((w) => w.status === "fail");
    const def = (seasons ?? []).find((s) => s.season_key === key);
    const isOngoing = def ? new Date() <= new Date(def.end_date) : false;
    let st;
    if (isOngoing) st = "진행 중";
    else if (hasRest && !hasFail) st = "통합 휴식";
    else if (hasFail && approved < totalWeeks / 2) st = "활동 중단";
    else st = approved >= totalWeeks - 1 ? "정상 졸업" : "정상 완료";
    console.log(` ${key}: total=${totalWeeks} approved=${approved} hasRest=${hasRest} hasFail=${hasFail} ongoing=${isOngoing} → ${st}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
