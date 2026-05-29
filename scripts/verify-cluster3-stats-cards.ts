// Cluster3 stats-cards DTO 검증 스크립트
// 실행: npx tsx --env-file=.env.local scripts/verify-cluster3-stats-cards.ts
//
// 목적: getCluster3StatsCards() 가 getGrowthIndicators() SoT 와 1:1 정합한지 확인.
//   (계산식 중복 없음 — stats-cards 는 admin growth 와 동일 함수의 매핑일 뿐임을 입증)

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getGrowthIndicators } from "@/lib/cluster3GrowthData";
import { getCluster3StatsCards } from "@/lib/cluster3StatsCardsData";

async function main() {
  const { data: profiles, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .not("organization_slug", "is", null)
    .order("created_at", { ascending: true })
    .limit(8);

  if (error) {
    console.error(error);
    return;
  }
  if (!profiles?.length) {
    console.log("No users found");
    return;
  }

  let pass = 0;
  let fail = 0;

  for (const p of profiles as Array<{ user_id: string; display_name: string }>) {
    const g = await getGrowthIndicators(p.user_id);
    const s = await getCluster3StatsCards(p.user_id);

    const checks: Array<[string, boolean]> = [
      ["process.growthStatus", s.process.growthStatus === g.process.growthStatusDisplay],
      ["process.growthStatusKey", s.process.growthStatusKey === g.process.growthDisplayKey],
      ["process.growthStatusRaw", s.process.growthStatusRaw === g.process.growthStatus],
      ["process.growthStartDate", s.process.growthStartDate === g.process.activityStartedAt],
      ["process.growthEndDate", s.process.growthEndDate === g.process.activityEndedAt],
      ["process.isBeCluving", s.process.isBeCluving === (g.process.activityEndedAt === null)],
      ["period.successWeeks", s.period.successWeeks === g.period.a],
      ["period.failWeeks", s.period.failWeeks === g.period.b],
      ["period.personalRestWeeks", s.period.personalRestWeeks === g.period.c],
      ["period.officialRestWeeks", s.period.officialRestWeeks === g.period.d],
      ["period.growableWeeks", s.period.growableWeeks === g.period.e],
      ["period.physicalWeeks", s.period.physicalWeeks === g.period.h],
      ["period.personalRestSeasons", s.period.personalRestSeasons === g.period.f],
      ["period.successSeasons", s.period.successSeasons === g.period.g],
      ["period.successWeeksPending(null)", s.period.successWeeksPending === null],
      ["period.personalRestWeeksPending(null)", s.period.personalRestWeeksPending === null],
      ["points.totalStars", s.points.totalStars === g.point.points],
      ["points.totalShields(=netAdvantages)", s.points.totalShields === g.point.netAdvantages],
      ["points.totalLightning", s.points.totalLightning === g.point.penalty],
    ];

    const failed = checks.filter(([, ok]) => !ok);
    if (failed.length === 0) {
      pass++;
      console.log(
        `OK  ${p.display_name}: status=${s.process.growthStatusKey} a=${s.period.successWeeks} ` +
          `e=${s.period.growableWeeks} stars=${s.points.totalStars} shields=${s.points.totalShields}`,
      );
    } else {
      fail++;
      console.log(`FAIL ${p.display_name}:`, failed.map(([k]) => k).join(", "));
    }
  }

  console.log(`\n검증 결과: ${pass} OK / ${fail} FAIL (전체 ${profiles.length}명)`);
}

main().catch(console.error);
