/**
 * user_weekly_points 변경 후 품계 캐시(user_grade_stats) 일괄 재계산.
 *
 * seed/script 가 포인트를 수정한 뒤 이 스크립트를 실행하면
 * cumulative → grade stats 순서로 app-level 동기화가 수행된다.
 * (수동 POST /api/admin/sync/grade-stats 호출을 대체한다.)
 *
 *   npm run sync:grade-stats
 *   # 변경된 사용자만 cumulative 를 명시적으로 재계산하려면 user_id 를 인자로:
 *   npx tsx --env-file=.env.local scripts/sync-grade-stats.ts <user_id> [<user_id> ...]
 *
 * 품계는 상대 백분위 기반이라 grade stats 는 항상 전체 사용자를 재계산한다.
 */
import { syncGrowthCachesAfterPointsChange } from "@/lib/cluster3ClubRankData";

async function main() {
  const affectedUserIds = process.argv.slice(2).filter(Boolean);

  console.log("[sync-grade-stats] 시작");
  if (affectedUserIds.length > 0) {
    console.log(`  cumulative 명시적 재계산 대상: ${affectedUserIds.length}명`);
  } else {
    console.log("  cumulative 는 DB 트리거가 동기화 — grade stats 전체 재계산만 수행");
  }

  const result = await syncGrowthCachesAfterPointsChange({ affectedUserIds });

  console.log(
    `\n[완료] cumulative 재계산 ${result.cumulativeResynced}명, ` +
      `grade stats synced ${result.gradeStats.synced}명 / skipped ${result.gradeStats.skipped}명`,
  );
}

main().catch((e) => {
  console.error("[sync-grade-stats] 실패:", e);
  process.exit(1);
});
