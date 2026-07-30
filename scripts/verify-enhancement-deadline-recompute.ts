// 검증(read+write: snapshot 재계산 트리거) — adminCrewWeekDetail.loadOverlaidCards 수정 후
// "라인 강화 내역"(getCrewWeekLineSummary → /api/cluster4/weekly-line-enhancement 동일 함수)이
// 마감(수 22:00 KST) 경과 pending 라인을 자동으로 success 로 수렴시키는지 확인한다.
import { getCrewWeekLineSummary } from "@/lib/adminCrewWeekLineSummary";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

async function main() {
  // 앞서 diag-enhancement-stale-repro.ts 로 찾은 실측 mismatch 케이스.
  const userId = "98807fea-2137-4160-ba5c-dedcbdced0e8";
  const weekId = "2d21a7cc-37ce-4223-acac-419bc5fa094b";
  const lineTargetId = "010e6d31-44b5-4428-a29e-ddfcdaa2f1a1"; // cluster4_line_targets.id (== row.id from prior diag)

  // getAdminCrewDtoByLegacyUserId 는 legacy id/UUID 모두 받아들인다(fetchCrewSourceRows 내부 처리).
  const legacyUserId = userId;

  const before = await readWeeklyCardsSnapshot(userId);
  console.log("[snapshot BEFORE]", before.status, (before as { computedAt?: string }).computedAt);

  const result = await getCrewWeekLineSummary(legacyUserId, weekId);
  if (!result.ok) {
    console.log("[getCrewWeekLineSummary] NOT OK:", result.reason);
    return;
  }
  console.log("[lineDetails count]", result.data.lineDetails.length);
  const experienceRows = result.data.lineDetails.filter((r) => r.partType === "experience");
  console.log("[experience rows]", experienceRows.map((r) => ({
    lineTargetId: r.lineTargetId,
    lineId: r.lineId,
    enhancementStatus: r.enhancementStatus,
    effectiveCanEdit: r.effectiveCanEdit,
    submissionClosesAt: r.submissionClosesAt,
  })));
  const row = result.data.lineDetails.find((r) => r.lineTargetId === lineTargetId);
  console.log("[getCrewWeekLineSummary row for target]", row ? {
    enhancementStatus: row.enhancementStatus,
    enhancementReason: row.enhancementReason,
    effectiveCanEdit: row.effectiveCanEdit,
    submissionClosesAt: row.submissionClosesAt,
  } : "NOT FOUND");

  const after = await readWeeklyCardsSnapshot(userId);
  console.log("[snapshot AFTER]", after.status, (after as { computedAt?: string }).computedAt);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
