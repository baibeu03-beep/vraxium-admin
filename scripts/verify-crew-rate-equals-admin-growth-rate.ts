/**
 * 크루 강화율 ↔ 어드민 주차 성장률 정합 (READ-ONLY).
 *   run: npx tsx --env-file=.env.local scripts/verify-crew-rate-equals-admin-growth-rate.ts
 *
 * 크루 DTO 의 강화율 필드명은 enhancementRate 이고, 어드민 SoT 의 대응 값은
 *   CrewWeekLineSummaryDto.weeklyGrowthRate(rawOpenLineGrowthRate = 오픈 라인 중 강화 성공 비율)다.
 * 두 값은 항상 같아야 한다 — v2 까지는 크루가 비배정 행을 분모에서 빼서 갈렸다(크루 100% vs 어드민 88%).
 */
import { getCrewWeekLineSummary } from "@/lib/adminCrewWeekLineSummary";
import { projectCrewLineEnhancement } from "@/lib/crewLineEnhancementProjection";

const TARGETS = [
  { label: "A (W28 · 포인트 실적)", userId: "00b75923-2109-4214-806a-37667d64ac5e", weekId: "39aae7a0-216f-4262-8a67-6beef1bccf22" },
  { label: "B (W28 · 타 유저)", userId: "3fec1a7e-4a88-4bc7-8da8-9eb9daff6f8a", weekId: "39aae7a0-216f-4262-8a67-6beef1bccf22" },
  { label: "C (W27)", userId: "59c22d30-aece-4855-9958-bf34f8795d2a", weekId: "496656d0-8d92-4738-b69b-e5e28aa1d57a" },
  { label: "D (W11 · 실패 3/4)", userId: "36138fb1-6fea-4b22-b6d2-9c46cba47314", weekId: "67e07106-564e-4dab-b180-8f11c909973a" },
  { label: "E (W9)", userId: "36138fb1-6fea-4b22-b6d2-9c46cba47314", weekId: "b531c234-e860-499a-992c-b74d2c1d5349" },
  { label: "F (W11 · 타 유저)", userId: "e649370f-ba2c-4d2f-b642-6800cb078d54", weekId: "67e07106-564e-4dab-b180-8f11c909973a" },
];

let checks = 0;
let failures = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  for (const t of TARGETS) {
    const r = await getCrewWeekLineSummary(t.userId, t.weekId);
    if (!r.ok) {
      ok(`${t.label}: summary 조회`, false, r.reason);
      continue;
    }
    const crew = projectCrewLineEnhancement({ userId: t.userId, weekId: t.weekId, summary: r.data });
    ok(
      `${t.label}: 크루 enhancementRate(${crew.summary.enhancementRate}) === 어드민 weeklyGrowthRate(${r.data.weeklyGrowthRate})`,
      crew.summary.enhancementRate === r.data.weeklyGrowthRate,
    );
    // 행 결과도 어드민 status 와 1:1 인지 재확인(오픈 행 기준).
    const open = r.data.lineDetails.filter((x) => x.clubOpen);
    const map: Record<string, string> = { success: "success", fail: "failure", not_applicable: "not_applicable", pending: "pending" };
    const mismatched = open.filter((row, i) => crew.rows[i]?.result !== map[row.enhancementStatus]);
    ok(`${t.label}: 오픈 행 ${open.length}개 결과 = 어드민 status`, mismatched.length === 0, `불일치 ${mismatched.length}`);
    const badLabel = open.filter((row, i) => crew.rows[i]?.resultLabel !== row.enhancementLabel);
    ok(`${t.label}: resultLabel = 어드민 enhancementLabel`, badLabel.length === 0, `불일치 ${badLabel.length}`);
  }
  console.log(`\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
