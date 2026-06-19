/**
 * 진단 2(read-only) — 한글깨짐 광역 스캔 + 품계 null 상세 분류(raw vs display 상태 divergence).
 *   npx tsx --env-file=.env.local scripts/diagnose-members-roster2.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";

const FFFD = "�";

async function pageAllStar<T>(table: string, columns = "*"): Promise<T[]> {
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

async function main() {
  // ── 2) 한글깨짐 광역 스캔: 테이블의 모든 string 컬럼 ─────────────────
  console.log("──── 2) 한글깨짐 광역 스캔(모든 string 컬럼) ────");
  const tables = [
    "user_profiles", "user_educations", "user_memberships", "schools",
    "teams", "organizations", "user_careers", "user_cluster2_photos",
  ];
  for (const t of tables) {
    try {
      const rows = await pageAllStar<Record<string, any>>(t);
      let hits = 0;
      const samples: string[] = [];
      const colHit = new Set<string>();
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === "string" && v.includes(FFFD)) {
            hits++; colHit.add(k);
            if (samples.length < 8) samples.push(`${k}="${v}" (id=${r.user_id ?? r.id ?? r.source_id ?? "?"})`);
          }
        }
      }
      console.log(`  ${t}: rows=${rows.length} · FFFD건수=${hits} · 컬럼=[${[...colHit].join(",")}]`);
      for (const s of samples) console.log("      ! " + s);
    } catch (e) {
      console.log(`  ${t}: (조회실패) ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log();

  // ── 3) 품계 null 상세 — raw growth_status vs display 상태 ────────────
  console.log("──── 3) 품계 null 상세(raw growth_status vs displayGrowthStatus) ────");
  const crews = await listAdminCrewDtos(undefined, "operating");
  const userIds = crews.map((c) => c.userId);

  // raw growth_status 분포(전 operating roster)
  const profRows = await pageAllStar<{ user_id: string; growth_status: string | null }>(
    "user_profiles", "user_id,growth_status",
  );
  const rawById = new Map(profRows.map((r) => [r.user_id, r.growth_status]));
  const rawDist = new Map<string, number>();
  for (const c of crews) {
    const s = rawById.get(c.userId) ?? "(null)";
    rawDist.set(s, (rawDist.get(s) ?? 0) + 1);
  }
  console.log("  [raw growth_status 분포 — operating roster 전체]");
  for (const [s, n] of [...rawDist.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${s} = ${n}`);

  // grade
  const gradeMap = await getClubRankGradeBatch(userIds);

  // displayGrowthStatus(청크 배치)
  const displayById = new Map<string, string>();
  const ID_CHUNK = 200;
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    const chunk = userIds.slice(i, i + ID_CHUNK);
    try {
      const rows = await getGrowthRosterBatchFast(chunk);
      for (const r of rows) displayById.set(r.userId, r.displayGrowthStatus);
    } catch (e) {
      console.log(`    (display 배치 실패 chunk ${i}) ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // null-grade 사용자: raw=seasonal_rest 인데 display 가 휴식이 아닌(=divergence) 케이스 추적
  let nullGrade = 0;
  const crossTab = new Map<string, number>(); // `${raw} → ${display}` 카운트
  const divergence: string[] = [];
  for (const c of crews) {
    const g = gradeMap.get(c.userId) ?? null;
    if (g) continue;
    nullGrade++;
    const raw = rawById.get(c.userId) ?? "(null)";
    const disp = displayById.get(c.userId) ?? "(none)";
    const key = `${raw} → ${disp}`;
    crossTab.set(key, (crossTab.get(key) ?? 0) + 1);
    // divergence: raw=seasonal_rest 인데 display 가 활동성(휴식/졸업/중단 아님)
    if (raw === "seasonal_rest" && !["seasonal_rest", "official_rest", "weekly_rest", "graduated", "suspended"].includes(disp)) {
      if (divergence.length < 15) divergence.push(`${c.displayName ?? c.userId} (${c.organizationSlug ?? "-"}): raw=${raw} · display=${disp}`);
    }
  }
  console.log(`\n  품계 null = ${nullGrade}명. [raw → display] 교차표:`);
  for (const [k, n] of [...crossTab.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k} = ${n}`);
  console.log(`\n  ⚠ divergence(raw=seasonal_rest 이나 display=활동성) 샘플 ${divergence.length}건:`);
  for (const d of divergence) console.log("    - " + d);

  console.log("\n=== 진단2 종료 ===");
}

main().catch((e) => { console.error("진단2 실패:", e); process.exit(1); });
