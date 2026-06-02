/**
 * 운영 DB 기준 /api/cluster4/weekly-cards 신규 평판/연계동료 DTO 검증.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-reputation-dto.ts
 *
 * 1) weekly_reputations(받은)·weekly_colleagues(작성한) 데이터가 있는 사용자 자동 탐색
 * 2) getCluster4WeeklyCardsForProfileUser 로 카드 계산 → 신규 DTO 필드 출력
 * 3) snapshot recompute → readback 으로 dto_version=5 + 신필드 영속 확인
 * 4) fameScore/fmScore 기존값 유지 확인(평판 fm 과 별개 축)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

function countBy<T>(rows: T[], key: (r: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

async function pickTargetUser(): Promise<string | null> {
  // 받은 평판이 가장 많은 (target_user_id, week) 조합 우선.
  const { data: rep } = await supabaseAdmin
    .from("weekly_reputations")
    .select("target_user_id,week_card_id")
    .limit(5000);
  const { data: col } = await supabaseAdmin
    .from("weekly_colleagues")
    .select("user_id,week_card_id")
    .limit(5000);

  const repByUser = countBy(rep ?? [], (r: any) => String(r.target_user_id));
  const colByUser = countBy(col ?? [], (r: any) => String(r.user_id));

  console.log(
    `[scan] weekly_reputations rows=${rep?.length ?? 0} (distinct target=${repByUser.size}) | ` +
      `weekly_colleagues rows=${col?.length ?? 0} (distinct user=${colByUser.size})`,
  );

  // 평판+동료 둘 다 있는 사용자 우선, 없으면 평판만, 없으면 동료만.
  let best: { uid: string; score: number } | null = null;
  for (const [uid, rc] of repByUser) {
    const cc = colByUser.get(uid) ?? 0;
    const score = (cc > 0 ? 1000 : 0) + rc + cc; // both 우선, 그다음 건수
    if (!best || score > best.score) best = { uid, score };
  }
  if (!best) {
    for (const [uid, cc] of colByUser) {
      if (!best || cc > best.score) best = { uid, score: cc };
    }
  }
  return best?.uid ?? null;
}

async function main() {
  console.log(`DTO_VERSION(code) = ${WEEKLY_CARDS_DTO_VERSION}\n`);

  const targetArg = process.argv[2] || null;
  const profileUserId = targetArg || (await pickTargetUser());
  if (!profileUserId) {
    console.log("❌ 평판/동료 데이터가 있는 사용자를 찾지 못했습니다.");
    return;
  }
  console.log(`[target] profileUserId = ${profileUserId}\n`);

  // ── 1) 실시간 계산 DTO ──
  const cards = await getCluster4WeeklyCardsForProfileUser(profileUserId);
  console.log(`[cards] total weeks = ${cards.length}`);

  const withData = cards.filter(
    (c) => c.weeklyReputations.length > 0 || c.weeklyColleagues.length > 0,
  );
  console.log(`[cards] weeks with 평판/동료 = ${withData.length}\n`);

  const sample = withData[0] ?? cards[0];
  if (!sample) {
    console.log("❌ 카드가 없습니다.");
    return;
  }

  const view = {
    weekId: sample.weekId,
    weekNumber: sample.weekNumber,
    displayTitle: sample.displayTitle,
    // 8) 기존 누적 명성도 유지 (평판 fm 과 별개 축)
    fameScore: sample.fameScore,
    fmScore: sample.fmScore,
    // 기존 호환 카운트
    reputationCount: sample.reputationCount,
    colleagueCount: sample.colleagueCount,
    // 1) 5) 요약
    reputationSummary: sample.reputationSummary,
    colleagueSummary: sample.colleagueSummary,
    // 2~4) 평판 상세 + 인적사항 + tagline
    weeklyReputations: sample.weeklyReputations,
    // 6~7) 동료 상세 + 인적사항 + tagline
    weeklyColleagues: sample.weeklyColleagues,
  };
  console.log("──────── 실제 DTO JSON (sample week) ────────");
  console.log(JSON.stringify(view, null, 2));

  // ── 2) snapshot recompute → readback (dto_version=5 확인) ──
  console.log("\n──────── snapshot recompute + readback ────────");
  await recomputeAndStoreWeeklyCardsSnapshot(profileUserId);
  const snap = await readWeeklyCardsSnapshot(profileUserId);
  console.log(`snapshot status = ${snap.status}`);
  if (snap.status === "hit" || snap.status === "stale") {
    const snapSample =
      snap.cards.find((c) => c.weekId === sample.weekId) ?? snap.cards[0];
    console.log(`snapshot card_count = ${snap.cards.length}`);
    console.log(
      `snapshot sample has reputationSummary = ${Boolean(snapSample?.reputationSummary)} | ` +
        `weeklyReputations len = ${snapSample?.weeklyReputations?.length ?? "MISSING"} | ` +
        `colleagueSummary = ${Boolean(snapSample?.colleagueSummary)}`,
    );
  }

  // raw 행으로 dto_version 직접 확인
  const { data: snapRow } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale,card_count,computed_at")
    .eq("user_id", profileUserId)
    .maybeSingle();
  console.log(
    `snapshot row: dto_version=${(snapRow as any)?.dto_version} ` +
      `(code=${WEEKLY_CARDS_DTO_VERSION}, match=${(snapRow as any)?.dto_version === WEEKLY_CARDS_DTO_VERSION}) ` +
      `is_stale=${(snapRow as any)?.is_stale} card_count=${(snapRow as any)?.card_count}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
