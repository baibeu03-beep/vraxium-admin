/**
 * READ-ONLY: 주차 경계 전환 시 자동 반영 검증 — direct function 결과 수집.
 *
 *   npx tsx --env-file=.env.local scripts/diag-week-transition-direct.ts
 *
 * 수집:
 *   1) describeCurrentWeek(날짜별) — 순수 날짜 기반 주차 계산
 *   2) getWeeklyGrowth(직접) — 테스터 1명 + 실유저 1명:
 *      currentWeekInfo / growthSummary(졸업·활동) / seasonSummary / seasonActivityStatuses
 *   3) readWeeklyCardsSnapshot — snapshot 상태(hit/stale)·computed_at·최신 카드 주차
 */
import { createClient } from "@supabase/supabase-js";
import { describeCurrentWeek } from "@/lib/cluster4WeekPolicy";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import {
  readWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function pickUsers(): Promise<{ tester: string | null; real: string | null }> {
  const { data: markers } = await sb
    .from("test_user_markers")
    .select("user_id")
    .limit(200);
  const testerSet = new Set((markers ?? []).map((m: any) => m.user_id));

  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, card_count")
    .order("card_count", { ascending: false })
    .limit(300);

  let tester: string | null = null;
  let real: string | null = null;
  for (const s of snaps ?? []) {
    if (testerSet.has(s.user_id)) {
      if (!tester) tester = s.user_id;
    } else if (!real) {
      real = s.user_id;
    }
    if (tester && real) break;
  }
  return { tester, real };
}

async function reportUser(label: string, userId: string) {
  console.log(`\n========== ${label} user=${userId} ==========`);

  // direct (live 계산)
  const dto = await getWeeklyGrowth(userId);
  if (!dto) {
    console.log("  getWeeklyGrowth → null (profile 없음)");
    return;
  }
  const cw = dto.currentWeekInfo;
  console.log(
    `  [direct] currentWeekInfo: ${cw.year} ${cw.seasonName} ${cw.weekNumber}주차 (${cw.startDate}~${cw.endDate}) status=${cw.status} restReason=${cw.restReason}`,
  );
  const g = dto.growthSummary;
  console.log(
    `  [direct] growthSummary: available=${g.availableWeeks} approved=${g.approvedWeeks} failed=${g.failedWeeks} rest=${g.restWeeks} endStatus=${g.endStatus} end="${g.endWeekDisplay}" start="${g.startWeekDisplay}"`,
  );
  const ss: any = dto.seasonSummary;
  console.log(
    `  [direct] seasonSummary: ${JSON.stringify(ss)}`,
  );
  console.log(
    `  [direct] seasonActivityStatuses: ${(dto.seasonActivityStatuses ?? [])
      .map((s: any) => `${s.teamLabel ?? "-"}/${s.partLabel ?? "-"}/${s.statusLabel ?? JSON.stringify(s)}`)
      .join(" | ") || "(없음)"}`,
  );
  const cards = dto.weeklyCards ?? [];
  console.log(`  [direct] weeklyCards: ${cards.length}장`);
  for (const c of cards.slice(-3)) {
    console.log(
      `    - ${(c as any).periodLabel ?? `${(c as any).year} w${(c as any).weekNumber}`} resultStatus=${(c as any).resultStatus} weekStatus=${(c as any).weekStatus ?? "-"} isTransition=${(c as any).isTransition}`,
    );
  }

  // snapshot (HTTP /api/cluster4/weekly-cards 가 그대로 반환하는 저장본)
  const snap = await readWeeklyCardsSnapshot(userId);
  const sCards: any[] = (snap as any).cards ?? [];
  const last = sCards[sCards.length - 1];
  console.log(
    `  [snapshot] status=${(snap as any).status} reason=${(snap as any).reason ?? "-"} computed_at=${(snap as any).computedAt ?? (snap as any).computed_at ?? "-"} dtoVersionExpected=${WEEKLY_CARDS_DTO_VERSION} cards=${sCards.length}`,
  );
  if (last) {
    console.log(
      `    최신 카드: ${last.periodLabel ?? `${last.year} w${last.weekNumber}`} resultStatus=${last.resultStatus}`,
    );
  }

  // direct cards vs snapshot cards 마지막 주차 비교
  const dLast: any = cards[cards.length - 1];
  if (dLast && last) {
    const same =
      dLast.periodLabel === last.periodLabel &&
      dLast.resultStatus === last.resultStatus;
    console.log(
      `  [비교] direct 최신(${dLast.periodLabel}/${dLast.resultStatus}) vs snapshot 최신(${last.periodLabel}/${last.resultStatus}) → ${same ? "일치" : "불일치"}`,
    );
  }
}

async function main() {
  console.log(`실행 시각(UTC): ${new Date().toISOString()}`);
  console.log("\n=== 날짜별 describeCurrentWeek (순수 함수) ===");
  for (const d of ["2026-06-04", "2026-06-07", "2026-06-08"]) {
    const w = describeCurrentWeek(d);
    console.log(
      `  ${d} → ${w?.seasonKey} ${w?.weekNumber}주차 (${w?.weekStart}~${w?.weekEnd}) officialRest=${w?.isOfficialRest}`,
    );
  }

  const { tester, real } = await pickUsers();
  console.log(`\n선정: tester=${tester} real=${real}`);
  if (tester) await reportUser("TESTER(demoUserId 대상)", tester);
  if (real) await reportUser("REAL(일반 사용자)", real);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
