/**
 * 2026-06-05 정합성 수정 직후 direct function 검증.
 *   1) getCluster1Resume.seasonRecords — "정상 졸업" = 실졸업 + 마지막 활동 시즌 행에만
 *   2) getWeeklyGrowth 카드 — 봄 시즌 24/25주차(ISO 폴백) → 15/16주차 교정
 *
 *   npx tsx --env-file=.env.local scripts/verify-status-week-fixes.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { getCluster1Resume } = await import("@/lib/cluster1ResumeData");
  const { getWeeklyGrowth } = await import("@/lib/cluster4WeeklyGrowthData");
  const { supabaseAdmin } = await import("@/lib/supabaseAdmin");

  // ── 1) 시즌 행 정상 졸업 게이팅 ──
  const cases: Array<[string, string, string]> = [
    ["T홍지환(graduated)", "e6574586-6279-41cc-ae36-1c9dc3078bc3", "spring 행=정상 졸업, winter=정상 완료 기대"],
    ["T안건우(graduating)", "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee", "정상 졸업 0건 기대(graduating 은 미졸업)"],
    ["이유나(active 실유저)", "247021bc-374b-48f4-8d49-b181d149ee33", "정상 졸업 0건 기대"],
  ];
  for (const [label, uid, expect] of cases) {
    const resume = await getCluster1Resume(uid);
    console.log(`\n[seasonRecords] ${label} — ${expect}`);
    for (const r of resume.seasonRecords) {
      console.log(`  ${r.year} ${r.seasonName}: ${r.progressStatus} (${r.approvedWeeks}/${r.totalWeeks}, ${r.reviewStatus})`);
    }
  }

  // ── 2) 주차 카드 시즌 초과 주차 ──
  const affected = [
    "42864260-e4ea-4150-a87f-cff545b02af1", // T임다인
    "e6574586-6279-41cc-ae36-1c9dc3078bc3", // T홍지환
  ];
  for (const uid of affected) {
    const growth = await getWeeklyGrowth(uid);
    const spring = growth.weeklyCards.filter((c) => c.seasonKey === "2026-spring");
    const nums = spring.map((c) => c.weekNumber).sort((a, b) => a - b);
    const over = spring.filter((c) => c.weekNumber > 16);
    console.log(`\n[weeklyCards] ${uid} 2026-spring weekNumbers: ${nums.join(",")}`);
    console.log(over.length === 0 ? "  ✓ 시즌 초과 주차 없음" : `  ✗ 초과 주차 잔존: ${over.map((c) => `W${c.weekNumber}@${c.startDate}`).join(" ")}`);
    const w15 = spring.find((c) => c.startDate === "2026-06-08");
    const w16 = spring.find((c) => c.startDate === "2026-06-15");
    console.log(`  06-08 카드 weekNumber=${w15?.weekNumber ?? "(카드 없음)"} / 06-15 카드 weekNumber=${w16?.weekNumber ?? "(카드 없음)"}`);
  }

  void supabaseAdmin;
}

main().catch((e) => {
  console.error("[verify-status-week-fixes] 실패:", e);
  process.exit(1);
});
