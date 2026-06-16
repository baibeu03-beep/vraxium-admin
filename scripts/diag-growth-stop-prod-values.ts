// READ-ONLY 조사 — 운영(non-test) 성장 중단 사용자의 주차 카드 핵심 값 점검.
//   weeklyGrowthRate / 허브별 성장률(lines) / checkGate / points / enhancementStatus 가
//   성장 중단 시 (A) null/blank 가 되는지 (B) 그대로 계산되고 배지만 중단인지 확인.
//   DTO direct(getCluster4WeeklyCardsForProfileUser) vs snapshot(readWeeklyCardsSnapshot)
//   + truncateCardsForGrowthStop 효과까지 비교. ※ 어떤 쓰기도 하지 않음.
//
//   npx tsx --env-file=.env.local scripts/diag-growth-stop-prod-values.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  loadGrowthStopInfo,
  truncateCardsForGrowthStop,
} from "@/lib/cluster4GrowthStopPolicy";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

function statusCounts(cards: Cluster4WeeklyCardDto[]): string {
  const c: Record<string, number> = {};
  for (const x of cards) c[x.userWeekStatus] = (c[x.userWeekStatus] ?? 0) + 1;
  return JSON.stringify(c);
}

function dumpCard(c: Cluster4WeeklyCardDto) {
  const hub = c.lines.map((l) => ({
    part: l.partType,
    n: l.numerator,
    d: l.denominator,
    enh: l.enhancementStatus,
  }));
  console.log(
    `   W${c.weekNumber} [${c.userWeekStatus}] growthRate=${c.weeklyGrowthRate} ` +
      `(${c.growthNumerator}/${c.growthDenominator}) ` +
      `points={star:${c.points.star},shield:${c.points.shield},lightning:${c.points.lightning}} ` +
      `cardEnh=${c.enhancementStatus} ` +
      `checkGate=${c.checkGate ? JSON.stringify(c.checkGate) : "—"}`,
  );
  console.log(`        hubLines=${JSON.stringify(hub)}`);
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();

  // 운영 성장 중단 후보: growth_status ∈ {suspended,paused}, 테스트 유저 제외.
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,growth_status,status,organization_slug")
    .in("growth_status", ["suspended", "paused"]);
  if (error) {
    console.error("query failed", error.message);
    process.exit(1);
  }
  const prod = (data ?? []).filter((r) => !testIds.has(r.user_id as string));
  console.log(
    `운영(non-test) 성장중단 후보 ${prod.length}명 (전체 ${(data ?? []).length}, test 제외 ${(data ?? []).length - prod.length})`,
  );
  for (const r of prod) {
    console.log(
      `  · ${r.display_name} [${r.organization_slug}] growth_status=${r.growth_status} status=${r.status} (${r.user_id})`,
    );
  }
  console.log("");

  // 카드를 실제로 가진 사용자를 우선 상세 점검(최대 3명).
  let shown = 0;
  for (const r of prod) {
    const userId = r.user_id as string;
    const info = await loadGrowthStopInfo(userId);

    const directCards = await getCluster4WeeklyCardsForProfileUser(userId);
    const snap = await readWeeklyCardsSnapshot(userId);
    const snapCards =
      snap.status === "hit" || snap.status === "stale" ? snap.cards : [];

    if (directCards.length === 0 && snapCards.length === 0) continue;
    if (shown >= 3) break;
    shown++;

    const directTrunc = truncateCardsForGrowthStop(directCards, info.isStopped);
    const snapTrunc = truncateCardsForGrowthStop(snapCards, info.isStopped);

    console.log(`══════════════════════════════════════════════════════════`);
    console.log(
      `● ${r.display_name} [${r.organization_slug}] growth_status=${r.growth_status}`,
    );
    console.log(
      `  growthInfo(envelope): status=${info.status} growthStatus=${info.growthStatus} isStopped=${info.isStopped}`,
    );
    console.log(
      `  snapshot status=${snap.status}${"reason" in snap ? " reason=" + (snap as { reason?: string }).reason : ""}`,
    );
    console.log(
      `  DIRECT(DTO 원본)  : ${directCards.length}장 ${statusCounts(directCards)}`,
    );
    directCards.forEach(dumpCard);
    console.log(
      `  SNAPSHOT(저장값)  : ${snapCards.length}장 ${statusCounts(snapCards)}`,
    );
    snapCards.forEach(dumpCard);
    console.log(
      `  HTTP/브라우저가 받는 값 = finalizeOk(truncate 적용):`,
    );
    console.log(
      `    DIRECT→trunc ${directTrunc.length}장 ${statusCounts(directTrunc)} (removed ${directCards.length - directTrunc.length})`,
    );
    console.log(
      `    SNAP  →trunc ${snapTrunc.length}장 ${statusCounts(snapTrunc)} (removed ${snapCards.length - snapTrunc.length})`,
    );

    // direct vs snapshot 의 5개 대상 필드 엄격 비교(weekId+weekNumber 인덱스 정렬).
    const proj = (c: Cluster4WeeklyCardDto) => ({
      w: `${c.weekId}#${c.weekNumber}`,
      gr: c.weeklyGrowthRate,
      gn: c.growthNumerator,
      gd: c.growthDenominator,
      pts: c.points,
      gate: c.checkGate ?? null,
      hub: c.lines.map((l) => ({ p: l.partType, n: l.numerator, d: l.denominator, e: l.enhancementStatus })),
    });
    const dProj = JSON.stringify(directCards.map(proj));
    const sProj = JSON.stringify(snapCards.map(proj));
    console.log(
      `  5개 대상필드 direct==snapshot : ${dProj === sProj ? "IDENTICAL ✓" : "DIVERGENT ✗"}`,
    );
    console.log("");
  }
  if (shown === 0) console.log("카드를 보유한 운영 성장중단 사용자 없음.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
