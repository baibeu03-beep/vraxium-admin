/**
 * verify-cluster3-club-rank-parity.ts
 *
 * "주차 평균 백분위" SoT 통일 검증.
 *
 * 목적:
 *   admin 화면(GET /api/admin/crews/[id]/cluster3/growth/rank)과
 *   사용자용 호스트 라우트(GET /api/cluster3/club-rank)는
 *   모두 동일한 getClubRank(userId) 를 재사용한다.
 *   따라서 같은 userId 에 대해 avgPercentile 이 정확히 일치해야 한다.
 *
 *   이 스크립트는 캐시(user_grade_stats.avg_percentile)와 실시간 getClubRank()
 *   값을 함께 출력해, 캐시가 stale 인지(불일치)와 실시간 SoT 값을 확인한다.
 *
 * 실행:
 *   npx tsx --env-file=.env.local scripts/verify-cluster3-club-rank-parity.ts <userIdOrEmail>
 *
 *   예: npx tsx --env-file=.env.local scripts/verify-cluster3-club-rank-parity.ts 23.aurum.06@gmail.com
 *
 * 기대 결과(검증 케이스):
 *   getClubRank().avgPercentile      = 39.5  → display "상위 39.50%"
 *   user_grade_stats.avg_percentile  = (캐시; stale 면 ≠ 39.5)
 */

import { getClubRank } from "@/lib/cluster3ClubRankData";
import { formatAvgPercentile } from "@/lib/cluster3GrowthTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProfileUserId } from "@/lib/resolveProfileUserId";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: tsx scripts/verify-cluster3-club-rank-parity.ts <userIdOrEmail>");
    process.exit(1);
  }

  // userId(uuid) 또는 email 모두 허용
  const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
  const userId = looksLikeUuid
    ? arg
    : await resolveProfileUserId(arg, arg);

  if (!userId) {
    console.error(`user_profiles 매칭 실패: ${arg}`);
    process.exit(1);
  }

  // 1) 실시간 SoT — getClubRank() (admin 화면 + /api/cluster3/club-rank 공통)
  const dto = await getClubRank(userId);
  const liveAvg = dto.avgPercentile;
  const liveDisplay = dto.avgPercentileDisplay;

  // 2) 캐시 — user_grade_stats.avg_percentile (수정 전 /api/profile 원천)
  const { data: cacheRow } = await supabaseAdmin
    .from("user_grade_stats")
    .select("avg_percentile, grade, grade_label, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  const cacheAvg = cacheRow ? Number((cacheRow as { avg_percentile: number | null }).avg_percentile) : null;

  console.log("─────────────────────────────────────────────");
  console.log("userId                         :", userId);
  console.log("isFrozen                       :", dto.isFrozen);
  console.log("rankGrade                      :", dto.rankGrade);
  console.log("─────────────────────────────────────────────");
  console.log("[SoT] getClubRank().avgPercentile  :", liveAvg, "→", liveDisplay);
  console.log("      formatAvgPercentile(live)    :", liveAvg === null ? "—" : formatAvgPercentile(liveAvg));
  console.log("[cache] user_grade_stats.avg_pct   :", cacheAvg, cacheRow ? `(updated_at=${(cacheRow as { updated_at: string }).updated_at})` : "(no row)");
  console.log("─────────────────────────────────────────────");

  if (cacheAvg === null) {
    console.log("→ 캐시 행 없음. 수정 후 /api/profile 은 실시간 값을 써야 함.");
  } else if (liveAvg !== null && Math.abs(liveAvg - cacheAvg) > 0.0001) {
    console.log(`⚠️  MISMATCH: live(${liveAvg}) ≠ cache(${cacheAvg}) — 캐시 stale 확인됨.`);
    console.log("   /api/profile 이 캐시를 읽으면 화면이 실시간과 어긋남.");
  } else {
    console.log("✅ live == cache (현재는 우연히 일치). SoT 는 live 값으로 통일.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
