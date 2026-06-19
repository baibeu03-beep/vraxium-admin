/**
 * 진단(read-only) — active 인데 품계(grade) null 인 사용자 색출·원인분류.
 *   운영/test roster 각각: seasonal_rest 제외(정상) / frozen 상태 / active+grade / active+null 분리.
 *   npx tsx --env-file=.env.local scripts/diagnose-active-null-grade.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { getClubRankGradeBatch, getRankPopulationExcludedUserIds } from "@/lib/cluster3ClubRankData";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { statusBucket } from "@/lib/memberStatusBucket";

const FROZEN = new Set(["graduated", "suspended", "withdrawn"]);

async function pageAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function run(mode: "operating" | "test") {
  console.log(`\n══════════ mode = ${mode} ══════════`);
  const crews = await listAdminCrewDtos(undefined, mode);
  const userIds = crews.map((c) => c.userId);

  const [gradeMap, excludedIds] = await Promise.all([
    getClubRankGradeBatch(userIds),
    getRankPopulationExcludedUserIds(),
  ]);

  // 보조 데이터
  const rawById = new Map(
    (await pageAll<{ user_id: string; growth_status: string | null }>("user_profiles", "user_id,growth_status"))
      .map((r) => [r.user_id, r.growth_status]),
  );
  const uwpUsers = new Set((await pageAll<{ user_id: string }>("user_weekly_points", "user_id")).map((r) => r.user_id));
  const uwsUsers = new Set((await pageAll<{ user_id: string }>("user_week_statuses", "user_id")).map((r) => r.user_id));
  const gradeStatsUsers = new Set((await pageAll<{ user_id: string }>("user_grade_stats", "user_id")).map((r) => r.user_id));
  const frozenUsers = new Set((await pageAll<{ user_id: string }>("user_club_rank_frozen", "user_id")).map((r) => r.user_id));

  // displayGrowthStatus(청크)
  const displayById = new Map<string, string>();
  const ID_CHUNK = 200;
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
    const rows = await getGrowthRosterBatchFast(chunk);
    for (const r of rows) displayById.set(r.userId, r.displayGrowthStatus);
  }

  let cntSeasonalExcluded = 0, cntFrozen = 0, cntActiveWithGrade = 0;
  const activeNull: any[] = [];

  for (const c of crews) {
    const raw = rawById.get(c.userId) ?? null;
    const disp = displayById.get(c.userId) ?? null;
    const bucket = statusBucket(disp);
    const grade = gradeMap.get(c.userId) ?? null;
    // "활동 중"으로 보이는 = raw active 또는 표시 버킷 active/elite(휴식·졸업·중단 아님)
    const looksActive =
      (raw === "active" || bucket === "active" || bucket === "elite") &&
      raw !== "seasonal_rest" && !FROZEN.has(raw ?? "") &&
      bucket !== "seasonal_rest" && bucket !== "suspended";

    if (raw === "seasonal_rest" || bucket === "seasonal_rest") { cntSeasonalExcluded++; continue; }
    if (FROZEN.has(raw ?? "") || bucket === "suspended") { cntFrozen++; continue; }

    if (looksActive) {
      if (grade) { cntActiveWithGrade++; }
      else {
        activeNull.push({
          userId: c.userId,
          displayName: c.displayName,
          org: c.organizationSlug,
          mode,
          rawStatus: raw,
          displayStatus: disp,
          bucket,
          hasUwp: uwpUsers.has(c.userId),
          inRankPopulation: !excludedIds.has(c.userId),
          hasGradeStatsCache: gradeStatsUsers.has(c.userId),
          hasUws: uwsUsers.has(c.userId),
          isFrozenRow: frozenUsers.has(c.userId),
        });
      }
    }
  }

  console.log(`  roster=${crews.length} · seasonal_rest 제외(정상)=${cntSeasonalExcluded} · frozen상태=${cntFrozen}`);
  console.log(`  active+품계 정상=${cntActiveWithGrade} · active+품계 NULL=${activeNull.length}`);
  if (activeNull.length) {
    console.log(`  ⚠ active 인데 품계 NULL 상세:`);
    for (const a of activeNull) {
      const reason = !a.hasUwp
        ? "user_weekly_points 없음"
        : !a.inRankPopulation
        ? "rank population 제외됨(seasonal_rest 외 사유)"
        : "적격주차 0(온보딩 1주차만/포인트행 있으나 순위산정 주차 없음)";
      console.log(`    - ${a.displayName} [${a.org}/${a.mode}] raw=${a.rawStatus} disp=${a.displayStatus} bucket=${a.bucket}`);
      console.log(`        uwp=${a.hasUwp} inPop=${a.inRankPopulation} gradeCache=${a.hasGradeStatsCache} uws=${a.hasUws} frozenRow=${a.isFrozenRow}`);
      console.log(`        userId=${a.userId}  → 원인: ${reason}`);
    }
  }
  return { mode, cntSeasonalExcluded, cntFrozen, cntActiveWithGrade, activeNull };
}

async function main() {
  const op = await run("operating");
  const test = await run("test");
  console.log("\n════════ 종합 ════════");
  for (const r of [op, test]) {
    console.log(`[${r.mode}] seasonal_rest제외=${r.cntSeasonalExcluded} · active+grade=${r.cntActiveWithGrade} · active+NULL=${r.activeNull.length} · frozen=${r.cntFrozen}`);
  }
}
main().catch((e) => { console.error("실패:", e); process.exit(1); });
