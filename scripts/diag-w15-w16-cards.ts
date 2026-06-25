/** W15/W16 snapshot 카드 실재 확인(전체 encre 로스터, 단일 로스터 조회). */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const { data: weeks } = await supabaseAdmin
    .from("weeks").select("id, week_number, start_date, end_date, is_official_rest, result_published_at")
    .eq("season_key", "2026-spring").gte("week_number", 14).lte("week_number", 17).order("week_number");
  const wmap = new Map((weeks ?? []).map((w: any) => [w.id, w]));

  const { data: roster } = await supabaseAdmin
    .from("user_profiles").select("user_id")
    .eq("organization_slug", "encre").not("activity_started_at", "is", null);
  const ids = (roster ?? []).map((r: any) => r.user_id);
  console.log("encre 로스터:", ids.length, "명");

  const distByWeek: Record<string, Record<string, number>> = {};
  const CH = 50;
  for (let i = 0; i < ids.length; i += CH) {
    const { data } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots").select("cards").in("user_id", ids.slice(i, i + CH));
    for (const row of (data ?? []) as any[]) {
      if (!Array.isArray(row.cards)) continue;
      for (const c of row.cards) {
        if (wmap.has(c.weekId)) {
          const wn = (wmap.get(c.weekId) as any).week_number;
          const key = `W${wn}`;
          distByWeek[key] = distByWeek[key] ?? {};
          distByWeek[key][c.userWeekStatus] = (distByWeek[key][c.userWeekStatus] ?? 0) + 1;
        }
      }
    }
  }
  for (const w of (weeks ?? []) as any[]) {
    const key = `W${w.week_number}`;
    const dist = distByWeek[key] ?? {};
    const total = Object.values(dist).reduce((s, n) => s + n, 0);
    console.log(`${key} (${w.start_date}~${w.end_date}) official_rest=${w.is_official_rest} pub=${w.result_published_at ?? "NULL"} → 카드 ${total}개 ${JSON.stringify(dist)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
