/**
 * READ-ONLY 검증: area-7-progress(실무 4허브 정보/경험/역량/경력 시즌 누적 강화율)의
 *   direct(실시간 계산 카드 → 집계) vs snapshot(저장 카드 → 집계) 일치 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-area7-progress.ts [sampleN]
 *
 * - HTTP GET /api/cluster4/weekly-cards 는 snapshot-only → 응답 cards == 저장 snapshot.cards,
 *   그리고 응답 seasonAreaProgress = computeSeasonAreaProgress(저장 cards, 현재시즌키) 로 서버가 계산.
 *   본 스크립트의 "snapshot" 열은 동일 함수·동일 입력이므로 곧 HTTP seasonAreaProgress 와 같다.
 * - "direct" 열은 getCluster4WeeklyCardsForProfileUser(실시간 재계산) → 동일 집계.
 *   direct == snapshot 이면 (스냅샷 fresh) → direct == HTTP == 브라우저(스냅샷 소비) 까지 일치.
 * - 추가 검증: 4허브 earned 합 == area-6 seasonGrowth completedLines, total 합 == availableLines.
 * - 쓰기/recompute 없음. 순수 읽기 + 비교만.
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  computeAreaSixCircles,
  computeSeasonAreaProgress,
} from "@/lib/cluster4SeasonCircles";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import type {
  Cluster4WeeklyCardDto,
  Cluster4SeasonAreaProgressDto,
} from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SAMPLE_N = Number(process.argv[2] ?? "8");

function curSeasonKey(): string | null {
  const s = getSeasonForDate(new Date().toISOString().slice(0, 10));
  return s ? seasonDbKey(s) : null;
}

function progressEqual(
  a: Cluster4SeasonAreaProgressDto,
  b: Cluster4SeasonAreaProgressDto,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.key === y.key &&
      x.rate === y.rate &&
      x.total === y.total &&
      x.earned === y.earned
    );
  });
}

function fmt(p: Cluster4SeasonAreaProgressDto): string {
  return p
    .map((x) => `${x.label} ${x.rate}%(${x.earned}/${x.total})`)
    .join(" · ");
}

async function main() {
  const seasonKey = curSeasonKey();
  console.log(`현재 시즌 key = ${seasonKey} | 코드 DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION}`);

  const { data: snapRows } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards");
  const rows = snapRows ?? [];

  const ranked = (rows as any[])
    .map((r) => ({ id: r.user_id, n: Array.isArray(r.cards) ? r.cards.length : 0 }))
    .sort((a, b) => b.n - a.n)
    .map((r) => r.id);
  const users = ranked.slice(0, SAMPLE_N);

  console.log(`\n표본 ${users.length}명: direct(실시간) vs snapshot(=HTTP seasonAreaProgress) 비교`);
  let mismatches = 0;
  let crossCheckFails = 0;
  for (const uid of users) {
    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("cards")
      .eq("user_id", uid)
      .maybeSingle();
    const storedCards = (Array.isArray(snap?.cards) ? snap!.cards : []) as Cluster4WeeklyCardDto[];
    const snapProgress = computeSeasonAreaProgress(storedCards, seasonKey);

    let directProgress: Cluster4SeasonAreaProgressDto;
    let directCircles;
    try {
      const liveCards = await getCluster4WeeklyCardsForProfileUser(uid);
      directProgress = computeSeasonAreaProgress(liveCards, seasonKey);
      directCircles = computeAreaSixCircles(liveCards, seasonKey);
    } catch (e) {
      console.log(`  ${uid.slice(0, 8)} ERROR direct: ${(e as Error).message}`);
      continue;
    }
    const eq = progressEqual(directProgress, snapProgress);
    if (!eq) mismatches++;

    // cross-check: 4허브 earned/total 합 == area-6 시즌 성장률 분자/분모 (direct 기준).
    const sumEarned = directProgress.reduce((s, x) => s + x.earned, 0);
    const sumTotal = directProgress.reduce((s, x) => s + x.total, 0);
    const crossOk =
      sumEarned === directCircles.completedLines &&
      sumTotal === directCircles.availableLines;
    if (!crossOk) crossCheckFails++;

    console.log(
      `  ${uid.slice(0, 8)} ${eq ? "OK " : "DIFF"} ${crossOk ? "x✓" : "x✗"}\n      direct  : ${fmt(directProgress)}\n      snapshot: ${fmt(snapProgress)}\n      cross   : Σearned=${sumEarned} vs area6.completed=${directCircles.completedLines} | Σtotal=${sumTotal} vs area6.available=${directCircles.availableLines}`,
    );
  }
  console.log(`\n불일치 유저(direct≠snapshot): ${mismatches} / ${users.length}`);
  console.log(`cross-check 실패(Σ허브 ≠ area-6 라인): ${crossCheckFails} / ${users.length}`);
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
