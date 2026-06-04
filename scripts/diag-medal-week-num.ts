/**
 * READ-ONLY 진단: 이력서 카드 medal-week-num(front /api/profile growthPeriodStats.approvedWeeks)
 * vs Details 카드 성장 성공 주차(admin stats-cards period.successWeeks = getGrowthIndicators g.period.a).
 *
 *   npx tsx --env-file=.env.local scripts/diag-medal-week-num.ts [userId...]
 *
 * 1) front 현재 산식 재현: raw uws status='success' 전체 카운트
 * 2) 제안 산식 재현: success ∧ 주차 공표(result_published_at)됨 ∧ 비전환 ∧ 비현재주
 * 3) admin getGrowthIndicators().period.a (Details SoT)
 * 4) success 행별 상세(published/transition/current) — +1 원인 주차 식별
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { getGrowthIndicators } from "@/lib/cluster3GrowthData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  let targets: { id: string; name: string }[] = [];
  const argIds = process.argv.slice(2);
  if (argIds.length > 0) {
    targets = argIds.map((id) => ({ id, name: "(arg)" }));
  } else {
    // 실유저(비테스터) 샘플 3명 + 테스터 1명
    const { data: markers } = await sb.from("test_user_markers").select("user_id");
    const testSet = new Set((markers ?? []).map((m: any) => m.user_id));
    const { data: ws } = await sb
      .from("user_week_statuses")
      .select("user_id")
      .eq("status", "success")
      .order("week_start_date", { ascending: false })
      .limit(1000);
    const realIds: string[] = [];
    const testerIds: string[] = [];
    for (const r of (ws ?? []) as any[]) {
      const bucket = testSet.has(r.user_id) ? testerIds : realIds;
      if (!bucket.includes(r.user_id)) bucket.push(r.user_id);
    }
    const pick = [...realIds.slice(0, 3), ...testerIds.slice(0, 1)];
    const { data: profiles } = await sb
      .from("user_profiles")
      .select("user_id, display_name")
      .in("user_id", pick);
    targets = pick.map((id) => ({
      id,
      name:
        ((profiles ?? []).find((p: any) => p.user_id === id) as any)?.display_name ??
        "?",
    }));
  }

  // weeks: start_date → { published, id }
  const { data: weeks } = await sb
    .from("weeks")
    .select("id, start_date, end_date, result_published_at")
    .order("start_date", { ascending: true });
  const weekByStart = new Map(
    ((weeks ?? []) as any[]).map((w) => [w.start_date, w]),
  );
  const todayIso = new Date().toISOString().slice(0, 10);

  for (const t of targets) {
    console.log(`\n════════ ${t.name} (${t.id}) ════════`);
    const { data: rows } = await sb
      .from("user_week_statuses")
      .select("week_start_date, status")
      .eq("user_id", t.id)
      .order("week_start_date", { ascending: true });
    const successRows = ((rows ?? []) as any[]).filter((r) => r.status === "success");

    let confirmedCount = 0;
    const detail: string[] = [];
    for (const r of successRows) {
      const w = weekByStart.get(r.week_start_date);
      const published = Boolean(w?.result_published_at);
      const isTransition = isTransitionWeekStart(r.week_start_date);
      const isCurrent = w ? w.start_date <= todayIso && todayIso <= w.end_date : false;
      const counted = published && !isTransition && !isCurrent;
      if (counted) confirmedCount++;
      if (!counted) {
        detail.push(
          `  EXCLUDED ${r.week_start_date}: published=${published} transition=${isTransition} current=${isCurrent}`,
        );
      }
    }

    console.log(`front 현재(raw success)        = ${successRows.length}`);
    console.log(`제안(published·비전환·비현재) = ${confirmedCount}`);
    detail.forEach((d) => console.log(d));

    try {
      const g = await getGrowthIndicators(t.id);
      console.log(
        `admin Details(g.period.a)      = ${g.period.a}  (b=${g.period.b} c=${g.period.c} e=${g.period.e})`,
      );
    } catch (e) {
      console.log("getGrowthIndicators threw:", (e as Error).message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
