/**
 * READ-ONLY 정밀 프로브: W13(a2112b50) competency 분모 1→2 불일치 근본원인.
 *   - 신규 개설 competency 라인 adadd283 의 target created_at vs 영향 유저 snapshot computed_at.
 *   - resume practicalStats(live) 4숫자 + experienceCount 의 rating 필터 교차검증.
 *   npx tsx --env-file=.env.local scripts/diag-w13-competency-stale.ts
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WEEK = "a2112b50"; // prefix; resolve full id
const NEW_LINE = "adadd283-9394-464b-a7a3-8988dcb302e9";
const SAMPLE_USER = "369d11e5"; // prefix

async function main() {
  // 2. 신규 competency 라인 + 그 라인의 모든 target (week 역추적)
  const { data: line } = await sb
    .from("cluster4_lines")
    .select("id,part_type,main_title,line_code,is_active,competency_line_master_id")
    .eq("id", NEW_LINE)
    .maybeSingle();
  console.log("══ 신규 competency 라인 ══");
  console.log(JSON.stringify(line, null, 2));

  const { data: allTgts } = await sb
    .from("cluster4_line_targets")
    .select("id,week_id,target_mode,target_user_id,created_at")
    .eq("line_id", NEW_LINE);
  console.log(`\n해당 라인 전체 target 수: ${allTgts?.length ?? 0}`);
  const weekIdsForLine = [...new Set((allTgts ?? []).map((t) => t.week_id))];
  for (const t of allTgts ?? []) {
    console.log(
      `  week=${String(t.week_id).slice(0, 8)} mode=${t.target_mode} user=${(t.target_user_id ?? "null").slice(0, 8)} created_at=${t.created_at}`,
    );
  }
  const earliestTargetCreate = (allTgts ?? [])
    .map((t) => t.created_at)
    .filter(Boolean)
    .sort()[0];
  console.log(`신규 라인 target 최초 생성시각: ${earliestTargetCreate}`);

  // 1. week row (target 의 week_id 로 역추적)
  const { data: weeks } = await sb
    .from("weeks")
    .select("id,week_number,season_key,start_date,result_published_at")
    .in("id", weekIdsForLine.length ? weekIdsForLine : ["00000000-0000-0000-0000-000000000000"]);
  const week = weeks?.[0];
  console.log("\n══ 해당 라인 week row ══");
  console.log(JSON.stringify(week, null, 2));

  // 3. 영향 유저 snapshot computed_at — earliestTargetCreate 보다 과거면 stale(미반영) 확정.
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,computed_at,is_stale,dto_version")
    .order("computed_at", { ascending: false })
    .limit(5);
  console.log("\n══ 최근 snapshot computed_at 표본 5 ══");
  for (const s of snaps ?? []) {
    const before = earliestTargetCreate && s.computed_at < earliestTargetCreate;
    console.log(
      `  user=${s.user_id.slice(0, 8)} computed_at=${s.computed_at} stale=${s.is_stale} ver=${s.dto_version} ${before ? "← 라인개설 이전(미반영)" : ""}`,
    );
  }

  // 4. 표본 유저 direct W13 카드 + resume practicalStats
  const { data: users } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id");
  const uid = (users ?? [])
    .map((u) => u.user_id)
    .find((id) => id.startsWith(SAMPLE_USER));
  if (!uid) {
    console.log("\n표본 유저 미발견");
    return;
  }
  console.log(`\n══ 표본 유저 ${uid.slice(0, 8)} ══`);

  const direct = await getCluster4WeeklyCardsForProfileUser(uid);
  const card = direct.find((c) => c.weekId === week?.id);
  if (card) {
    console.log(
      `[direct] W13 주차성장률=${card.weeklyGrowthRate}% (${card.growthNumerator}/${card.growthDenominator})`,
    );
    const byPart: Record<string, { n: number | null; d: number | null; r: number | null; count: number }> = {};
    for (const l of card.lines) {
      const p = l.partType;
      if (!byPart[p]) byPart[p] = { n: l.numerator, d: l.denominator, r: l.rate, count: 0 };
      byPart[p].count++;
    }
    for (const p of ["information", "experience", "competency", "career"]) {
      const b = byPart[p];
      if (b) console.log(`  [${p}] 칸수=${b.count} 허브: ${b.n}/${b.d} (${b.r}%)`);
    }
  }

  // stored snapshot W13
  const { data: snapRow } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("cards,computed_at")
    .eq("user_id", uid)
    .maybeSingle();
  const storedCards = Array.isArray(snapRow?.cards) ? (snapRow!.cards as any[]) : [];
  const storedCard = storedCards.find((c) => c.weekId === week?.id);
  if (storedCard) {
    console.log(
      `[stored=HTTP] W13 주차성장률=${storedCard.weeklyGrowthRate}% (${storedCard.growthNumerator}/${storedCard.growthDenominator}) computed_at=${snapRow?.computed_at}`,
    );
  }

  // 5. resume practicalStats (live) — legacy_user_id 필요. crew 조회.
  const { data: prof } = await sb
    .from("user_profiles")
    .select("legacy_user_id,organization_slug")
    .eq("user_id", uid)
    .maybeSingle();
  console.log(`\n표본 org=${prof?.organization_slug} legacy=${prof?.legacy_user_id}`);
  if (prof?.legacy_user_id) {
    const resume = await getCluster1Resume(prof.legacy_user_id);
    console.log("\n══ resume-skills 4숫자 (live, HTTP==direct) ══");
    console.log(JSON.stringify(resume?.practicalStats, null, 2));
    console.log("activityCompletion:", JSON.stringify(resume?.activityCompletion));
  }

  // 6. experienceCount rating 교차검증: resume(필터없음) vs weekly-cards(rating<=3 제외) 합
  console.log("\n══ experience 합산 비교 (rating 필터 차이 점검) ══");
  let weeklyExpSum = 0;
  for (const c of direct) {
    if (c.isRestWeek) continue;
    const expLines = c.lines.filter((l) => l.partType === "experience");
    // 대표 numerator (허브 completed) — 한 part 의 모든 칸이 동일 hub 값.
    const rep = expLines.find((l) => l.numerator != null);
    if (rep?.numerator != null) weeklyExpSum += rep.numerator;
  }
  console.log(`weekly-cards experience completed 합(rating<=3 제외) = ${weeklyExpSum}`);
  console.log("(resume.practicalStats.experienceCount 는 rating 필터 없음 — 위 값과 다르면 정책 불일치)");
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
