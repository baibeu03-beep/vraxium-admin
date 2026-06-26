/**
 * READ-ONLY 진단: 봄 시즌(legacy) 주차의 experience breakdown(=experienceRate 후보) 점검.
 *   npx tsx --env-file=.env.local scripts/diag-experience-rate-spring.ts
 *
 * 목적: breakdownFromLines 가 레거시 [통합] 임시 라인을 experience.available 에 포함하는지 실측.
 *   (DB write 없음.)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function sampleSpringUserIds(limit: number): Promise<string[]> {
  // 2026-spring 주차 id 들
  const { data: weeks } = await sb
    .from("weeks")
    .select("id,season_key,start_date")
    .lt("start_date", "2026-06-29");
  const weekIds = (weeks ?? []).map((w: { id: string }) => w.id);
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,week_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .in("week_id", weekIds.slice(0, 200))
    .limit(5000);
  return [...new Set(((data ?? []) as { target_user_id: string }[]).map((r) => r.target_user_id))].slice(0, limit);
}

async function main() {
  const users = await sampleSpringUserIds(40);
  console.log(`봄 시즌 타깃 사용자 ${users.length}명 스캔\n`);
  let printed = 0;
  for (const uid of users) {
    let cards;
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch (e) {
      continue;
    }
    const spring = cards.filter((c) => c.startDate < "2026-06-29" && !c.isRestWeek);
    for (const c of spring) {
      const exp = c.lines.filter((l) => l.partType === "experience");
      const open = exp.filter((l) => l.enhancementStatus !== "not_applicable");
      const na = exp.filter((l) => l.enhancementStatus === "not_applicable");
      const avail = exp.map((l) => l.denominator).find((d) => d != null) ?? null;
      const num = exp.map((l) => l.numerator).find((d) => d != null) ?? null;
      if (exp.length === 0) continue;
      console.log(
        `user=${uid.slice(0, 8)} week=${c.weekLabel} status=${c.userWeekStatus} | exp lines=${exp.length} open(non-na)=${open.length} na=${na.length} | denominator(avail)=${avail} numerator=${num}`,
      );
      for (const l of open) {
        console.log(`    [open] master=${l.experienceLineMasterId?.slice(0, 8) ?? "-"} lineName=${(l as any).lineName ?? "-"} enh=${l.enhancementStatus} status=${l.status}`);
      }
      printed++;
      if (printed >= 25) break;
    }
    if (printed >= 25) break;
  }
  console.log("\n== 진단 종료(읽기 전용) ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
