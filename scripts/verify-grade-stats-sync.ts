/**
 * verify-grade-stats-sync.ts
 * syncGrowthCachesAfterPointsChange() 가 user_grade_stats 를 실제로 갱신하는지 검증.
 *
 *   npm run verify:grade-stats-sync
 *
 * 검증 항목:
 *   1. 동기화 전/후 updated_at 스냅샷 비교 — synced 사용자의 updated_at 이 실제로 전진하는지
 *      (app-level upsert 가 updated_at 을 갱신하지 않으면 여기서 실패한다.)
 *   2. grade stats 가 전체 사용자 기준으로 재계산되는지 (상대 백분위)
 *   3. avg_percentile → grade 매핑 정합성
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { syncGrowthCachesAfterPointsChange } from "@/lib/cluster3ClubRankData";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type GradeRow = {
  user_id: string;
  avg_percentile: number | null;
  grade: number | null;
  grade_label: string | null;
  updated_at: string;
};

async function snapshot(): Promise<Map<string, GradeRow>> {
  const map = new Map<string, GradeRow>();
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("user_grade_stats")
      .select("user_id,avg_percentile,grade,grade_label,updated_at")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`snapshot fetch: ${error.message}`);
    const rows = (data ?? []) as GradeRow[];
    for (const r of rows) map.set(r.user_id, r);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return map;
}

function gradeForPercentile(pct: number): number {
  const c = Math.ceil(pct);
  if (c <= 10) return 1;
  if (c <= 20) return 2;
  if (c <= 30) return 3;
  if (c <= 40) return 4;
  if (c <= 50) return 5;
  if (c <= 60) return 6;
  if (c <= 70) return 7;
  if (c <= 80) return 8;
  if (c <= 90) return 9;
  return 10;
}

async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log("  품계 캐시 동기화 검증");
  console.log("══════════════════════════════════════════════════════\n");

  // ── 1. 동기화 전 스냅샷 ──
  const before = await snapshot();
  console.log(`  [before] user_grade_stats 행 수: ${before.size}`);

  // ── 2. app-level 동기화 실행 ──
  console.log("  syncGrowthCachesAfterPointsChange() 실행...\n");
  const result = await syncGrowthCachesAfterPointsChange();
  console.log(
    `  → cumulative 재계산 ${result.cumulativeResynced}명, ` +
      `grade synced ${result.gradeStats.synced}명 / skipped ${result.gradeStats.skipped}명\n`,
  );

  // ── 3. 동기화 후 스냅샷 ──
  const after = await snapshot();
  console.log(`  [after] user_grade_stats 행 수: ${after.size}\n`);

  // ── 검증 1: synced 사용자의 updated_at 전진 ──
  console.log("──────────────────────────────────────────────────────");
  console.log("  검증 1: updated_at 갱신");
  console.log("──────────────────────────────────────────────────────");

  const syncedUsers = result.gradeStats.results.filter((r) => r.grade !== null);
  let advanced = 0;
  let stale = 0;
  const staleSamples: string[] = [];

  for (const u of syncedUsers) {
    const a = after.get(u.userId);
    if (!a) continue;
    const b = before.get(u.userId);
    const advancedTs =
      !b || new Date(a.updated_at).getTime() > new Date(b.updated_at).getTime();
    if (advancedTs) {
      advanced++;
    } else {
      stale++;
      if (staleSamples.length < 5) {
        staleSamples.push(`    ${u.userId}: before=${b!.updated_at} after=${a.updated_at}`);
      }
    }
  }

  if (stale === 0) {
    console.log(`  ✅ synced ${syncedUsers.length}명 전원 updated_at 전진 (${advanced}건)\n`);
  } else {
    console.log(`  ❌ updated_at 미갱신 ${stale}건 (전진 ${advanced}건)`);
    for (const s of staleSamples) console.log(s);
    console.log();
  }

  // ── 검증 2: 전체 사용자 재계산 여부 ──
  console.log("──────────────────────────────────────────────────────");
  console.log("  검증 2: 전체 사용자 재계산 (상대 백분위)");
  console.log("──────────────────────────────────────────────────────");

  const { count: orgUserCount } = await supabase
    .from("user_profiles")
    .select("user_id", { count: "exact", head: true })
    .not("organization_slug", "is", null);

  const processed = result.gradeStats.synced + result.gradeStats.skipped;
  if (orgUserCount != null && processed === orgUserCount) {
    console.log(
      `  ✅ organization 소속 ${orgUserCount}명 전원 처리 (synced+skipped=${processed})\n`,
    );
  } else {
    console.log(
      `  ⚠️  처리 수(${processed}) ≠ org 사용자 수(${orgUserCount ?? "?"}) — 전체 재계산 확인 필요\n`,
    );
  }

  // ── 검증 3: grade 매핑 정합성 ──
  console.log("──────────────────────────────────────────────────────");
  console.log("  검증 3: avg_percentile → grade 매핑 정합성");
  console.log("──────────────────────────────────────────────────────");

  let mismatch = 0;
  const mismatchSamples: string[] = [];
  for (const [, r] of after) {
    if (r.avg_percentile == null || r.grade == null) continue;
    const expected = gradeForPercentile(Number(r.avg_percentile));
    if (expected !== r.grade) {
      mismatch++;
      if (mismatchSamples.length < 5) {
        mismatchSamples.push(
          `    ${r.user_id}: pct=${r.avg_percentile} grade=${r.grade} (expected ${expected})`,
        );
      }
    }
  }
  if (mismatch === 0) {
    console.log("  ✅ grade 매핑 전원 정합\n");
  } else {
    console.log(`  ❌ ${mismatch}건 불일치`);
    for (const s of mismatchSamples) console.log(s);
    console.log();
  }

  const pass = stale === 0 && mismatch === 0;
  console.log("══════════════════════════════════════════════════════");
  console.log(pass ? "  ✅ 전체 검증 통과" : "  ❌ 검증 실패 — 위 항목 확인");
  console.log("══════════════════════════════════════════════════════");
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
