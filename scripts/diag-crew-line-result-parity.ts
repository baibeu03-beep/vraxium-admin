/**
 * 라인 강화 내역 admin ↔ 크루 결과 정합 실측 (READ-ONLY).
 *   run: npx tsx --env-file=.env.local scripts/diag-crew-line-result-parity.ts [userId] [weekId]
 *
 * 목적: 같은 (userId, weekId) 에 대해
 *   - admin SoT  = getCrewWeekLineSummary().lineDetails[].enhancementStatus (관리자 표가 그리는 값)
 *   - 크루 DTO   = projectCrewLineEnhancement().rows[].result
 *   두 값을 행 단위로 나란히 놓고 불일치 행의 원본 필드를 덤프한다.
 *
 * 무손실: 오직 읽기만 한다(쓰기 없음).
 */
import { getCrewWeekLineSummary } from "@/lib/adminCrewWeekLineSummary";
import { projectCrewLineEnhancement } from "@/lib/crewLineEnhancementProjection";

const DEFAULT_USER = "00b75923-2109-4214-806a-37667d64ac5e";
const DEFAULT_WEEK = "39aae7a0-216f-4262-8a67-6beef1bccf22";

// admin enhancementStatus → 크루 result 축으로 정규화(비교 전용 — 프로덕션 매핑 아님).
const ADMIN_TO_CREW: Record<string, string> = {
  success: "success",
  fail: "failure",
  not_applicable: "not_applicable",
  pending: "pending",
};

async function main() {
  const userId = process.argv[2] || DEFAULT_USER;
  const weekId = process.argv[3] || DEFAULT_WEEK;

  const res = await getCrewWeekLineSummary(userId, weekId);
  if (!res.ok) {
    console.log("getCrewWeekLineSummary FAILED:", res.reason);
    return;
  }
  const summary = res.data;
  const crew = projectCrewLineEnhancement({ userId, weekId, summary });

  console.log("=== admin summary.results (enhancementStatus 버킷) ===");
  console.log(JSON.stringify(summary.results));
  console.log("admin lines:", JSON.stringify(summary.lines));
  console.log("");
  console.log("=== crew summary ===");
  console.log(
    JSON.stringify({
      clubOpenCount: crew.summary.clubOpenCount,
      crewOpenCount: crew.summary.crewOpenCount,
      successCount: crew.summary.successCount,
      failureCount: crew.summary.failureCount,
      notApplicableCount: crew.summary.notApplicableCount,
      pendingCount: crew.summary.pendingCount,
    }),
  );
  console.log("");

  // 크루 rows 는 clubOpen 행만·순서 보존 → admin 의 clubOpen 행과 index 정렬이 1:1 대응.
  const adminOpen = summary.lineDetails.filter((r) => r.clubOpen);
  console.log("=== 행 단위 비교 (clubOpen 행만) ===");
  console.log(
    ["idx", "part", "admin.status", "crew.result", "ltid", "lineId", "reason", "submission", "lineName"].join(" | "),
  );

  let mismatch = 0;
  adminOpen.forEach((row, i) => {
    const crewRow = crew.rows[i];
    const adminAsCrew = ADMIN_TO_CREW[row.enhancementStatus] ?? row.enhancementStatus;
    const differs = crewRow.result !== adminAsCrew;
    if (differs) mismatch += 1;
    console.log(
      [
        String(i).padEnd(3),
        row.partType.padEnd(11),
        row.enhancementStatus.padEnd(12),
        crewRow.result.padEnd(14),
        row.lineTargetId ? "SET" : "null",
        row.lineId ? "SET" : "null",
        String(row.enhancementReason).padEnd(28),
        String(row.submissionStatus).padEnd(12),
        String(row.lineName).slice(0, 26),
        differs ? "  <<< MISMATCH" : "",
      ].join(" | "),
    );
  });

  console.log("");
  console.log(`clubOpen 행 ${adminOpen.length}개 중 불일치 ${mismatch}개`);

  // 크루 표에서 빠지는 미오픈 행(행 포함 여부 축) 도 같이 본다.
  const unopened = summary.lineDetails.filter((r) => !r.clubOpen);
  console.log(`미오픈 행(admin 표엔 있고 크루 표엔 없음): ${unopened.length}개`);
  unopened.forEach((r) => {
    console.log(
      `   - ${r.partType.padEnd(11)} ${r.enhancementStatus.padEnd(12)} ltid=${r.lineTargetId ? "SET" : "null"} ${String(r.lineName).slice(0, 26)}`,
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
