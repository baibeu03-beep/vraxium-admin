/**
 * READ-ONLY 검증: area-6-circles(주차 활용도/일정 신뢰도/시즌 성장률)의
 *   direct(실시간 계산 카드 → 집계) vs snapshot(저장 카드 → 집계) 일치 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-area6-circles.ts [sampleN]
 *
 * - HTTP GET /api/cluster4/weekly-cards 는 snapshot-only → 응답 cards == 저장 snapshot.cards,
 *   그리고 응답 areaSixCircles = computeAreaSixCircles(저장 cards, 현재시즌키) 로 서버가 계산한다.
 *   본 스크립트의 "snapshot" 열은 동일 함수·동일 입력이므로 곧 HTTP areaSixCircles 와 같다.
 * - "direct" 열은 getCluster4WeeklyCardsForProfileUser(실시간 재계산) → 동일 집계.
 *   direct == snapshot 이면 (스냅샷 fresh) → direct == HTTP == 브라우저(스냅샷 소비) 까지 일치.
 * - 쓰기/recompute 없음. 순수 읽기 + 비교만.
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { computeAreaSixCircles } from "@/lib/cluster4SeasonCircles";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import type { Cluster4WeeklyCardDto, Cluster4AreaSixCirclesDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SAMPLE_N = Number(process.argv[2] ?? "8");

function curSeasonKey(): string | null {
  const s = getSeasonForDate(new Date().toISOString().slice(0, 10));
  return s ? seasonDbKey(s) : null;
}

function circlesEqual(a: Cluster4AreaSixCirclesDto, b: Cluster4AreaSixCirclesDto): boolean {
  return (
    a.seasonKey === b.seasonKey &&
    a.weekUsage === b.weekUsage &&
    a.approvedWeeks === b.approvedWeeks &&
    a.scheduleReliability === b.scheduleReliability &&
    a.reliableWeeks === b.reliableWeeks &&
    a.restWeeks === b.restWeeks &&
    a.availableWeeks === b.availableWeeks &&
    a.seasonGrowth === b.seasonGrowth &&
    a.completedLines === b.completedLines &&
    a.availableLines === b.availableLines
  );
}

function fmt(c: Cluster4AreaSixCirclesDto): string {
  return `활용 ${c.weekUsage}%(${c.approvedWeeks}/${c.availableWeeks}) · 신뢰 ${c.scheduleReliability}%(${c.reliableWeeks}/${c.availableWeeks}) · 성장 ${c.seasonGrowth}%(${c.completedLines}/${c.availableLines})`;
}

async function main() {
  const seasonKey = curSeasonKey();
  console.log(`현재 시즌 key = ${seasonKey} | 코드 DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION}`);

  // 1. snapshot 전수 버전 분포 (v10 수렴 확인)
  const { data: snapRows } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,cards");
  const rows = snapRows ?? [];
  const byVer: Record<string, number> = {};
  let staleTrue = 0;
  let missingSeasonKey = 0;
  for (const r of rows as any[]) {
    byVer[r.dto_version] = (byVer[r.dto_version] ?? 0) + 1;
    if (r.is_stale) staleTrue++;
    const cards = Array.isArray(r.cards) ? r.cards : [];
    if (cards.length > 0 && !("seasonKey" in cards[0])) missingSeasonKey++;
  }
  console.log(`총 snapshot 행: ${rows.length}`);
  console.log(`dto_version 분포: ${JSON.stringify(byVer)}`);
  console.log(`is_stale=true: ${staleTrue} | seasonKey 키 없는 행: ${missingSeasonKey}`);

  // 2. 표본: 카드(저장)가 많은 유저 우선 → 현재 시즌 카드 가질 확률 높음
  const ranked = (rows as any[])
    .map((r) => ({ id: r.user_id, n: Array.isArray(r.cards) ? r.cards.length : 0 }))
    .sort((a, b) => b.n - a.n)
    .map((r) => r.id);
  const users = ranked.slice(0, SAMPLE_N);

  console.log(`\n표본 ${users.length}명: direct(실시간) vs snapshot(=HTTP areaSixCircles) 비교`);
  let mismatches = 0;
  for (const uid of users) {
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("cards")
      .eq("user_id", uid)
      .maybeSingle();
    const storedCards = (Array.isArray(snap?.cards) ? snap!.cards : []) as Cluster4WeeklyCardDto[];
    const snapCircles = computeAreaSixCircles(storedCards, seasonKey);

    let directCircles: Cluster4AreaSixCirclesDto;
    try {
      const liveCards = await getCluster4WeeklyCardsForProfileUser(uid);
      directCircles = computeAreaSixCircles(liveCards, seasonKey);
    } catch (e) {
      console.log(`  ${uid.slice(0, 8)} ERROR direct: ${(e as Error).message}`);
      continue;
    }
    const eq = circlesEqual(directCircles, snapCircles);
    if (!eq) mismatches++;
    console.log(
      `  ${uid.slice(0, 8)} ${eq ? "OK " : "DIFF"}\n      direct  : ${fmt(directCircles)}\n      snapshot: ${fmt(snapCircles)}`,
    );
  }
  console.log(`\n불일치 유저: ${mismatches} / ${users.length}`);
  if (mismatches > 0) {
    console.log("⚠ direct≠snapshot → 해당 유저 snapshot 이 stale. recompute 필요(조회는 stale 노출).");
  } else {
    console.log("✅ 표본 전원 direct==snapshot → direct==HTTP==브라우저(스냅샷 소비) 일치.");
  }
  console.log("\n== 종료 (읽기 전용) ==");
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
