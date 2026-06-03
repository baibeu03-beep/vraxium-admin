/**
 * 이력서 카드 포인트 누적 검증.
 *   이력서 카드 / cluster-4-card / cluster-4-1 / user_weekly_points 직접합산을
 *   같은 유저로 비교하고 불일치를 원인별로 분류한다.
 *
 *   npx tsx --env-file=.env.local scripts/diag-resume-points-cumulative.ts
 *   npx tsx --env-file=.env.local scripts/diag-resume-points-cumulative.ts <N>   # 상위 N명만
 *
 * 비교 4축:
 *   A. user_weekly_points 직접 합산 (canonical SoT, 전체기간·전 point_type)
 *   B. 이력서 카드 source = user_cumulative_points (resume-card API 와 동일 컬럼)
 *   C. cluster-4-card fameScore (getCluster4WeeklyCardsForProfileUser 최신카드)
 *   D. cluster-4-1 seasonPointSummary (getWeeklyGrowth, 현재시즌·비전환 only)
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listTestUsers } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";

type WeeklyRow = { points: number; advantages: number; penalty: number };

// A. user_weekly_points 전체기간 직접 합산 (season/week 필터 없음).
async function directSum(userId: string) {
  const rows: WeeklyRow[] = [];
  // 페이지네이션 — 1000행 초과 대비.
  let from = 0;
  const page = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("points,advantages,penalty")
      .eq("user_id", userId)
      .range(from, from + page - 1);
    if (error) throw new Error(`user_weekly_points: ${error.message}`);
    const batch = (data ?? []) as WeeklyRow[];
    rows.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  let star = 0,
    adv = 0,
    pen = 0;
  for (const r of rows) {
    star += r.points ?? 0;
    adv += r.advantages ?? 0;
    pen += r.penalty ?? 0;
  }
  return {
    weeks: rows.length,
    star, // Σ points
    rawAdv: adv, // Σ advantages
    lightning: pen, // Σ penalty
    shield: adv - Math.abs(pen), // 방패(net) = raw_adv - |penalty|
    fmWeighted: star + adv * 3 - pen * 5, // cluster-4-card FM 공식
  };
}

// B. 이력서 카드가 읽는 캐시 테이블. 어떤 컬럼셋이 존재하는지까지 탐지.
async function resumeCardSource(userId: string) {
  // B1. resume-card API 가 실제로 select 하는 컬럼.
  const apiCols = await supabaseAdmin
    .from("user_cumulative_points")
    .select("total_checks,total_advantages,total_penalties")
    .eq("user_id", userId)
    .maybeSingle();
  // B2. 2026-05-28 sync 트리거가 유지하는 컬럼.
  const syncCols = await supabaseAdmin
    .from("user_cumulative_points")
    .select("total_stars,total_raw_advantages,total_lightnings,total_shields")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    apiColsError: apiCols.error?.message ?? null,
    api: (apiCols.data ?? null) as {
      total_checks: number | null;
      total_advantages: number | null;
      total_penalties: number | null;
    } | null,
    syncColsError: syncCols.error?.message ?? null,
    sync: (syncCols.data ?? null) as {
      total_stars: number | null;
      total_raw_advantages: number | null;
      total_lightnings: number | null;
      total_shields: number | null;
    } | null,
  };
}

function fmtNum(n: number | null | undefined): string {
  return n == null ? "·" : String(n);
}

async function main() {
  const limitArg = Number(process.argv[2]);
  const users = await listTestUsers();
  console.log(`[diag] test users = ${users.length}\n`);

  // 컬럼 존재 1회 진단 (첫 유저).
  if (users[0]) {
    const probe = await resumeCardSource(users[0].userId);
    console.log("──────── user_cumulative_points 컬럼 진단 ────────");
    console.log(
      `  resume-card 컬럼(total_checks/advantages/penalties): ${
        probe.apiColsError ? "❌ " + probe.apiColsError : "✅ 존재"
      }`,
    );
    console.log(
      `  sync 트리거 컬럼(total_stars/raw_advantages/lightnings/shields): ${
        probe.syncColsError ? "❌ " + probe.syncColsError : "✅ 존재"
      }`,
    );
    console.log("");
  }

  type Row = {
    name: string;
    org: string | null;
    A: Awaited<ReturnType<typeof directSum>>;
    B: Awaited<ReturnType<typeof resumeCardSource>>;
    cCard: number | null; // cluster-4-card 최신 fameScore
    cCumInjeolmi: number | null;
    dSeason: { star: number; shield: number; lightning: number } | null;
    classes: string[];
  };

  const out: Row[] = [];

  for (const u of users) {
    let A: Awaited<ReturnType<typeof directSum>>;
    try {
      A = await directSum(u.userId);
    } catch (e) {
      console.warn(`  skip ${u.name}: ${(e as Error).message}`);
      continue;
    }
    if (A.weeks === 0) continue; // 포인트 데이터 없는 유저 제외.

    const B = await resumeCardSource(u.userId);

    let cCard: number | null = null;
    let cCumInjeolmi: number | null = null;
    try {
      const cards = await getCluster4WeeklyCardsForProfileUser(u.userId);
      // 카드는 최신순 — 최신(가장 누적이 큰) fameScore 가 "현재 누적".
      const withFame = cards.find((c) => c.fameScore != null);
      cCard = withFame?.fameScore ?? null;
      const withInj = cards.find((c) => c.cumulativeInjeolmi != null);
      cCumInjeolmi = withInj?.cumulativeInjeolmi ?? null;
    } catch (e) {
      cCard = null;
    }

    let dSeason: Row["dSeason"] = null;
    try {
      const growth = await getWeeklyGrowth(u.userId);
      dSeason = growth?.seasonPointSummary ?? null;
    } catch {
      dSeason = null;
    }

    // 불일치 분류.
    const classes: string[] = [];
    // (1) 이력서 캐시 vs 직접합산 — stale 여부 (별).
    const cacheStar = B.api?.total_checks ?? null;
    if (cacheStar != null && cacheStar !== A.star) {
      classes.push(`CACHE_STALE(별 cache=${cacheStar} vs direct=${A.star})`);
    }
    if (B.api == null && B.apiColsError == null) {
      classes.push("CACHE_ROW_MISSING(이력서 별=null)");
    }
    if (B.apiColsError) classes.push("RESUME_COL_MISSING");
    // (2) cluster-4-card 는 가중 FM — 별 raw 와 다른 축인지 확인.
    if (cCard != null && cCard === A.star) {
      classes.push("CARD_EQ_RAWSTAR");
    }
    if (cCard != null && cCard === A.fmWeighted) {
      classes.push("CARD_EQ_FMWEIGHTED");
    }
    // (3) cluster-4-1 시즌요약 — 전체기간 별과 다르면 시즌범위만 합산 신호.
    if (dSeason && dSeason.star !== A.star) {
      classes.push(`SEASON_SCOPED(시즌별=${dSeason.star} vs 전체=${A.star})`);
    }

    out.push({
      name: u.name,
      org: u.organizationSlug,
      A,
      B,
      cCard,
      cCumInjeolmi,
      dSeason,
      classes,
    });
  }

  out.sort((a, b) => b.A.star - a.A.star);
  const rows = Number.isFinite(limitArg) && limitArg > 0 ? out.slice(0, limitArg) : out;

  console.log(`──────── 포인트 4축 비교 (비제로 유저 ${out.length}명) ────────\n`);
  for (const r of rows) {
    console.log(`■ ${r.name}  [${r.org ?? "-"}]  weeks=${r.A.weeks}`);
    console.log(
      `   A. user_weekly_points 직접합산: 별(Σpoints)=${r.A.star}  방패(net)=${r.A.shield}  번개(Σpenalty)=${r.A.lightning}  | FM가중=${r.A.fmWeighted}`,
    );
    console.log(
      `   B. 이력서 카드(user_cumulative_points): 별=${fmtNum(
        r.B.api?.total_checks,
      )}  방패(raw_adv)=${fmtNum(r.B.api?.total_advantages)}  번개=${fmtNum(
        r.B.api?.total_penalties,
      )}${r.B.apiColsError ? "  ❌" + r.B.apiColsError : ""}`,
    );
    if (r.B.sync && !r.B.syncColsError) {
      console.log(
        `      (sync컬럼: stars=${fmtNum(r.B.sync.total_stars)} raw_adv=${fmtNum(
          r.B.sync.total_raw_advantages,
        )} lightnings=${fmtNum(r.B.sync.total_lightnings)} shields=${fmtNum(
          r.B.sync.total_shields,
        )})`,
      );
    }
    console.log(
      `   C. cluster-4-card fameScore(최신, 가중누적)=${fmtNum(
        r.cCard,
      )}  cumulativeInjeolmi(Σadv)=${fmtNum(r.cCumInjeolmi)}`,
    );
    console.log(
      `   D. cluster-4-1 seasonPointSummary(현재시즌·비전환): 별=${fmtNum(
        r.dSeason?.star,
      )} 방패=${fmtNum(r.dSeason?.shield)} 번개=${fmtNum(r.dSeason?.lightning)}`,
    );
    console.log(
      `   ⇒ 분류: ${r.classes.length ? r.classes.join(" | ") : "✅ 일치/정상축"}`,
    );
    console.log("");
  }

  // 요약 집계.
  const staleCount = out.filter((r) =>
    r.classes.some((c) => c.startsWith("CACHE_STALE")),
  ).length;
  const missingRow = out.filter((r) =>
    r.classes.some((c) => c.startsWith("CACHE_ROW_MISSING")),
  ).length;
  const colMissing = out.filter((r) => r.classes.includes("RESUME_COL_MISSING")).length;
  console.log("──────── 분류 요약 ────────");
  console.log(`  CACHE_STALE (이력서 별 ≠ 직접합산): ${staleCount} / ${out.length}`);
  console.log(`  CACHE_ROW_MISSING (이력서 별=null): ${missingRow} / ${out.length}`);
  console.log(`  RESUME_COL_MISSING (select 컬럼 부재): ${colMissing} / ${out.length}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
