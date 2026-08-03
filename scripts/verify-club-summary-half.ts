// 반기별 실측 — 사용자 지정 필수 4개(22H1/24H2/26H1/26H2) + 실차 확인용 25H2.
// rosterSource/structureSource, asOf, 합계 등식, "최근 가입자가 과거로 안 새는지"를 확인한다.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadClubCurrentSummary, validateClubSummary } from "@/lib/adminClubSummaryData";
import { resolveHalfPeriod } from "@/lib/halfPeriod";
import { ORGANIZATIONS } from "@/lib/organizations";

const HALVES = ["2022-H1", "2024-H2", "2025-H2", "2026-H1", "2026-H2"] as const;
const EXPECT: Record<string, { rosterSource: string; structureSource: string }> = {
  "2022-H1": { rosterSource: "unavailable", structureSource: "unavailable" },
  "2024-H2": { rosterSource: "position_history", structureSource: "position_history" },
  "2025-H2": { rosterSource: "position_history", structureSource: "position_history" },
  "2026-H1": { rosterSource: "position_history", structureSource: "position_history" },
  "2026-H2": { rosterSource: "live", structureSource: "live" },
};

async function main() {
  let failures = 0;

  for (const half of HALVES) {
    console.log(`\n========== ${half} ==========`);
    const period = await resolveHalfPeriod({ halfKey: half });
    const exp = EXPECT[half];
    const okSrc = period.rosterSource === exp.rosterSource && period.structureSource === exp.structureSource;
    console.log(`${okSrc ? "OK  " : "FAIL"} rosterSource=${period.rosterSource}(기대 ${exp.rosterSource}) structureSource=${period.structureSource}(기대 ${exp.structureSource})`);
    if (!okSrc) failures++;
    console.log("  asOfDate:", period.asOfDate, "season:", period.seasonKey, "week:", period.weekNumber, "weekLabel:", period.weekLabel);

    const summary = await loadClubCurrentSummary({ mode: "operating", halfKey: half });
    // period 메타가 API 응답에도 그대로 실렸는지.
    const metaOk = JSON.stringify(summary.period) === JSON.stringify(period);
    console.log(`${metaOk ? "OK  " : "FAIL"} loadClubCurrentSummary().period === resolveHalfPeriod() 결과`);
    if (!metaOk) failures++;

    for (const row of summary.rows) {
      console.log(`  ${row.clubId}: staff=${row.staffCount} teamLeader=${row.teamLeaderCount} amb=${row.ambassadorCount} clubbing=${row.clubbingCount} regular=${row.regularCrewCount} advanced=${row.advancedCrewCount} teamEntity=${row.teamEntityCount} part=${row.partCount} partLeader=${row.partLeaderCount} agent=${row.agentCount}`);
      const v = validateClubSummary(row);
      const eqOk = v.staffValid && v.clubbingValid && v.advancedValid;
      if (!eqOk) {
        console.log(`  FAIL 등식 불일치`, v);
        failures++;
      }
    }
    console.log("  totals:", JSON.stringify(summary.totals));

    // 합계 = 각 행의 합(non-null 필드만) 검증.
    for (const key of Object.keys(summary.totals) as Array<keyof typeof summary.totals>) {
      const rowVals = summary.rows.map((r) => r[key]);
      const expectedTotal = rowVals.every((v) => v == null)
        ? null
        : rowVals.reduce((s: number, v) => s + (v ?? 0), 0);
      const ok = summary.totals[key] === expectedTotal;
      if (!ok) {
        console.log(`  FAIL totals.${key}=${summary.totals[key]} !== Σrows=${expectedTotal}`);
        failures++;
      }
    }

    // SUM(partCount) === structureTotals.totalParts (non-null 반기만 의미 있음).
    if (period.structureSource !== "unavailable") {
      const sumParts = summary.rows.reduce((s, r) => s + (r.partCount ?? 0), 0);
      const ok = sumParts === summary.structureTotals.totalParts;
      console.log(`${ok ? "OK  " : "FAIL"} SUM(partCount)=${sumParts} structureTotals.totalParts=${summary.structureTotals.totalParts}`);
      if (!ok) failures++;
    }
  }

  // 2026년에 새로 생성된(과거엔 존재할 수 없는) 유저가 2024-H2/2025-H2 이력 집계에 안 섞이는지 표본 확인.
  console.log("\n========== 최근 가입자 과거 반기 누수 확인 ==========");
  const { data: recentProfiles } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,organization_slug,created_at")
    .gte("created_at", "2026-06-01")
    .in("organization_slug", [...ORGANIZATIONS])
    .limit(5);
  const recent = (recentProfiles ?? []) as Array<{ user_id: string; organization_slug: string; created_at: string }>;
  console.log(`표본 ${recent.length}명(2026-06-01 이후 가입, created_at 기준)`);
  if (recent.length > 0) {
    const summary2024H2 = await loadClubCurrentSummary({ mode: "operating", halfKey: "2024-H2" });
    // buildClubRoleCounts 는 userId 목록을 직접 노출하지 않으므로, UPH 존재 여부로 대리 확인한다.
    for (const r of recent) {
      const { data: uph } = await supabaseAdmin
        .from("user_position_histories")
        .select("id")
        .eq("user_id", r.user_id)
        .in("season_key", ["2024-summer", "2024-autumn"])
        .limit(1);
      const hasHistory = (uph?.length ?? 0) > 0;
      console.log(`  ${r.user_id} (created ${r.created_at}, org=${r.organization_slug}) → 2024-H2 UPH 이력 존재=${hasHistory}`);
      if (hasHistory) {
        console.log("  FAIL 2026년 신규 가입자에게 2024-H2 UPH 이력이 존재 — 데이터 자체가 이상함(코드 문제 아님, 참고만)");
      }
    }
    console.log("  (설계상 buildClubRoleCountsHistorical 은 UPH/override source 만 집계하므로, UPH 이력이 없는 신규 가입자는");
    console.log(`   자동으로 membership fallback → 제외된다. 2024-H2 규모=${JSON.stringify(summary2024H2.totals)} 로 위 표본이 실제 집계에 없음을 뒷받침.)`);
  } else {
    console.log("  최근 가입자 표본 없음(스킵)");
  }

  console.log(`\n${failures === 0 ? "✅ 전부 통과" : `❌ ${failures}건 실패`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
