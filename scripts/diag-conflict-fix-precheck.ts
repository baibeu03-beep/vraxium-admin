// read-only 사전 점검: C/B그룹 수정 영향 범위 + A그룹(2023-autumn) 운영 데이터 소비 여부
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function count(table: string, build: (q: any) => any): Promise<number> {
  const { count: c, error } = await build(
    supabaseAdmin.from(table).select("*", { count: "exact", head: true }),
  );
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

async function main() {
  // ── C그룹: 2025 설 period 등록 시 stale 대상(uws week_start_date in 주차 범위) ──
  const { data: cUws } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id,status")
    .gte("week_start_date", "2025-01-27")
    .lte("week_start_date", "2025-02-02");
  const cUsers = new Set((cUws ?? []).map((r) => r.user_id));
  console.log(`[C] 2025-01-27~02-02 uws rows=${cUws?.length ?? 0}, distinct users=${cUsers.size}`);
  const byStatus: Record<string, number> = {};
  for (const r of cUws ?? []) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`[C] status 분포:`, JSON.stringify(byStatus));

  // 현재 stale snapshot 수 (before)
  const staleBefore = await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true));
  const snapTotal = await count("cluster4_weekly_card_snapshots", (q) => q);
  console.log(`[snapshot] is_stale=true: ${staleBefore} / total ${snapTotal}`);

  // ── B그룹: 2024-autumn 6주차에 uws/points 존재 여부 ──
  const bDates = ["2024-10-07","2024-10-14","2024-10-21","2024-12-02","2024-12-09","2024-12-16"];
  for (const d of bDates) {
    const uws = await count("user_week_statuses", (q) => q.eq("week_start_date", d));
    const uwp = await count("user_weekly_points", (q) => q.eq("week_start_date", d));
    console.log(`[B] ${d}: uws=${uws}, points=${uwp}`);
  }

  // ── A그룹: 2023-autumn 11~13주차(11월 정상행 + 12월 오기행) 소비 데이터 ──
  const aDates = ["2023-11-13","2023-11-20","2023-11-27","2023-12-04","2023-12-11","2023-12-18"];
  for (const d of aDates) {
    const uws = await count("user_week_statuses", (q) => q.eq("week_start_date", d));
    const uwp = await count("user_weekly_points", (q) => q.eq("week_start_date", d));
    console.log(`[A] ${d}: uws=${uws}, points=${uwp}`);
  }
  const aUwsSeason = await count("user_week_statuses", (q) => q.eq("season_key", "2023-autumn"));
  const aUss = await count("user_season_statuses", (q) => q.eq("season_key", "2023-autumn"));
  const aUwp2023 = await count("user_weekly_points", (q) => q.gte("week_start_date", "2023-01-01").lte("week_start_date", "2023-12-31"));
  const aUws2023 = await count("user_week_statuses", (q) => q.gte("week_start_date", "2023-01-01").lte("week_start_date", "2023-12-31"));
  console.log(`[A] uws season_key=2023-autumn: ${aUwsSeason}, uss 2023-autumn: ${aUss}`);
  console.log(`[A] 2023년 전체: uws=${aUws2023}, points=${aUwp2023}`);

  // user_season_histories → seasons 테이블(uuid) 기준이라 별도: seasons 에 2023 가을 있는지
  const { data: seasons2023 } = await supabaseAdmin
    .from("seasons")
    .select("id,name,started_at,ended_at")
    .gte("started_at", "2023-08-01")
    .lte("started_at", "2023-10-01");
  console.log(`[A] seasons(uuid) 2023 가을 후보:`, JSON.stringify(seasons2023));
  for (const s of seasons2023 ?? []) {
    const ush = await count("user_season_histories", (q) => q.eq("season_id", s.id));
    console.log(`[A] user_season_histories season_id=${s.id}(${s.name}): ${ush}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
