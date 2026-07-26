// READ-ONLY 진단 5 — 2026-07-25 마이그레이션 적용 여부 확정 + 복구 원천 탐색.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function probe(table: string, cols = "*") {
  const { data, error, count } = await supabaseAdmin
    .from(table)
    .select(cols, { count: "exact" })
    .limit(1);
  if (error) return `  ${table.padEnd(38)} ✗ ${error.code ?? ""} ${error.message.slice(0, 80)}`;
  return `  ${table.padEnd(38)} ✓ ${count}행  cols=${Object.keys((data?.[0] ?? {}) as object).join(",").slice(0, 160)}`;
}

async function main() {
  console.log("=== [1] 복구 원천 후보 테이블 ===");
  for (const t of [
    "legacy_point_ledger",
    "user_cumulative_points",
    "cluster4_roster_card_stats",
    "pms_pointlogs",
    "legacy_pointlogs",
    "_backup_user_weekly_points",
    "_backup_uwp_20260725",
    "user_week_statuses",
    "user_grade_stats",
  ]) {
    console.log(await probe(t));
  }

  console.log("\n=== [2] user_cumulative_points / roster stats 갱신 시각 ===");
  for (const [t, col] of [["user_cumulative_points", "updated_at"], ["cluster4_roster_card_stats", "updated_at"]] as const) {
    const { data, error } = await supabaseAdmin.from(t).select(col).order(col, { ascending: false }).limit(3);
    if (error) { console.log(`  ${t}: ✗ ${error.message}`); continue; }
    console.log(`  ${t} 최신 ${col}: ${(data ?? []).map((r) => (r as Record<string, unknown>)[col]).join(" | ")}`);
  }

  // roster slim 이 마이그 §4 로 덮였는지: 대표 사용자 비교
  console.log("\n=== [3] 대표 사용자: uwp 주차별 상세(checks_migrated 포함) ===");
  const targets = [
    { id: "76a42307-f3b2-4c08-92ab-f339a20b7d38", name: "T윤서진" },
    { id: "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", name: "윤채영" },
  ];
  const { data: wRaw } = await supabaseAdmin
    .from("weeks").select("season_key,week_number,start_date,is_official_rest").range(0, 999);
  const weekByStart = new Map(((wRaw ?? []) as Array<{ season_key: string; week_number: number; start_date: string; is_official_rest: boolean }>)
    .map((w) => [w.start_date, w]));

  for (const t of targets) {
    const { data } = await supabaseAdmin
      .from("user_weekly_points")
      .select("year,week_number,week_start_date,points,advantages,penalty,checks_migrated,created_at,updated_at")
      .eq("user_id", t.id)
      .order("week_start_date", { ascending: true });
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    console.log(`\n[${t.name}] ${rows.length}행`);
    for (const r of rows) {
      const w = weekByStart.get(String(r.week_start_date));
      console.log(
        `  ${r.week_start_date} ${(w?.season_key ?? "?").padEnd(12)} W${String(w?.week_number ?? "?").padEnd(3)}` +
          `${w?.is_official_rest ? " 휴식" : "  · "} A=${String(r.points).padStart(4)} adv=${String(r.advantages).padStart(4)} ` +
          `pen=${String(r.penalty).padStart(3)} migrated=${r.checks_migrated ? "T" : "F"} ` +
          `created=${String(r.created_at).slice(0, 19)} updated=${String(r.updated_at).slice(0, 19)}`,
      );
    }
    const { data: rs } = await supabaseAdmin
      .from("cluster4_roster_card_stats").select("po_a,po_b,po_c,updated_at").eq("user_id", t.id).maybeSingle();
    console.log(`  roster slim: ${JSON.stringify(rs)}`);
    const { data: cp } = await supabaseAdmin
      .from("user_cumulative_points").select("*").eq("user_id", t.id).maybeSingle();
    console.log(`  cumulative : ${JSON.stringify(cp)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
